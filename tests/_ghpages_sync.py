#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
gh-pages 单文件同步（plumbing 版）

背景：本机 gh-pages 的本地 ref 常常落后于远端（Pages 服务端会重建 commit，
内容字节一致但 SHA 不同），且 github-api-push.mjs 只比对 commit SHA，
不检测「本地 ref 落后」，会被误判为「已同步」。

做法：不 checkout、不动工作区，直接用 plumbing 构造一个新 commit：
  1) hash-object -w 写入新的 index.html blob
  2) 读远端 gh-pages 的 tree，替换 index.html 条目、保留其它条目
  3) mktree 生成新 tree，commit-tree 生成 commit、update-ref 移动 ref
  4) 交由 github-api-push.mjs 推送

⚠️⚠️ 血的教训（2026-09-30 线上故障）：
   gh-pages 分支**只有 index.html + README.md，没有 vendor/ 目录**。
   因此这里的 index.html 必须来自 **index.single.html（单文件内联版）**，
   绝不能直接用多文件版 index.html —— 后者含
       <script src="vendor/xlsx.full.min.js">
       <script src="vendor/exceljs.min.js">
   两个引用在 gh-pages 上必然 404 → XLSX 未定义 → **所有上传文件都被标为「未识别」**，
   页面看着正常、点分析毫无反应，极难排查。
   本脚本原先 SOURCE 误写成 index.html，导致 4d57700 / 391a4c0 两次发布都是坏产物。
   → 现已改为读取 index.single.html，并在 sync 前做**自包含校验**（见 verify_self_contained）。
"""
import subprocess
import sys
import os
import re
import time

BRANCH = "gh-pages"
FILE = "index.html"          # gh-pages 里的目标文件名
SOURCE = "index.single.html"  # ← 内容来源：必须是单文件内联版！


def verify_self_contained(path):
    """发布前把关：单文件版不得含任何指向 vendor/ 的外部引用，且必须内联 SheetJS。"""
    text = open(path, encoding="utf-8", errors="replace").read()
    ext = re.findall(r'<(?:script|link)[^>]*(?:src|href)=["\']([^"\']+)["\']', text)
    bad = [e for e in ext if not e.startswith(("http://", "https://", "data:"))]
    if bad:
        print("✗ %s 仍引用外部文件：%s" % (path, bad))
        print("  单文件版必须是自包含的（vendor 已内联）。请确认 build.py --single 已重新构建。")
        sys.exit(1)
    if "XLSX=" not in text or "SheetJS" not in text:
        print("✗ %s 未检测到内联的 SheetJS（XLSX= / SheetJS 标记缺失）。" % path)
        sys.exit(1)
    print("✓ 自包含校验通过：无外部引用，SheetJS 已内联")
    return len(text.encode("utf-8"))


def git(args, inp=None, check=True):
    r = subprocess.run(["git"] + args, input=inp, capture_output=True)
    if check and r.returncode != 0:
        print("ERR git " + " ".join(args))
        print(r.stderr.decode("utf-8", "replace"))
        sys.exit(1)
    return r.stdout


def main():
    # 0) 先 fetch，保证 origin/gh-pages 是远端最新
    #    （本机 gh-pages 本地 ref 常落后于远端，不 fetch 会把新 commit 建在旧 parent 上）
    #    github.com:443 在本机间歇性不通（schannel: server closed abruptly），
    #    故重试若干次；全部失败则**沿用已有的 origin/gh-pages** 并明确告警。
    print("fetch origin " + BRANCH + " ...")
    ok = False
    for attempt in range(1, 6):
        r = subprocess.run(["git", "fetch", "origin", BRANCH], capture_output=True)
        if r.returncode == 0:
            print("  fetch 成功（第 %d 次）" % attempt)
            ok = True
            break
        print("  第 %d 次失败：%s" % (attempt, r.stderr.decode("utf-8", "replace").strip()[:100]))
        time.sleep(6)
    if not ok:
        have = subprocess.run(["git", "rev-parse", "--verify", "origin/" + BRANCH],
                              capture_output=True).returncode == 0
        if not have:
            print("✗ fetch 失败且本地无 origin/" + BRANCH + "，无法继续。")
            sys.exit(1)
        print("⚠ fetch 全部失败，沿用已有 origin/%s —— 若远端刚被改过，parent 可能不是最新。" % BRANCH)

    # 0.5) 发布前把关：内容来源必须是自包含的单文件版
    if not os.path.exists(SOURCE):
        print("✗ 找不到 " + SOURCE + "，请先执行：python build.py --single")
        sys.exit(1)
    size = verify_self_contained(SOURCE)
    print("源文件 %s = %d 字节" % (SOURCE, size))

    # 1) 新 index.html blob（内容取自单文件版）
    blob = git(["hash-object", "-w", SOURCE]).decode().strip()
    print("新 blob = " + blob + "  (%d 字节)" % int(git(["cat-file", "-s", blob]).decode().strip()))

    # 2) 读远端 tree，替换目标条目
    raw = git(["ls-tree", "-r", "origin/" + BRANCH]).decode()
    entries = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        meta, path = line.split("\t", 1)
        mode, typ, sha = meta.split()
        if path == FILE:
            sha = blob
        entries.append((mode, typ, sha, path))

    print("tree 条目:")
    for mode, typ, sha, path in entries:
        print("  %s %s %s\t%s" % (mode, typ, sha, path))

    # 3) mktree -> commit-tree -> update-ref
    tree_src = "".join("%s %s %s\t%s\n" % e for e in entries).encode()
    tree = git(["mktree"], inp=tree_src).decode().strip()
    print("新 tree = " + tree)

    # 3.5) 最后一道防线：写在 gh-pages 上的 index.html 必须仍是「大文件」
    #      单文件内联版约 2 MB；多文件版只有 ~250 KB。阈值 1 MB 足以区分。
    final_size = int(git(["cat-file", "-s", blob]).decode().strip())
    if final_size < 1_000_000:
        print("✗ 拒绝发布：index.html 仅 %d 字节，疑似多文件版混入（正确产物约 2 MB）。" % final_size)
        sys.exit(1)
    print("✓ 体积校验通过：%d 字节" % final_size)

    parent = git(["rev-parse", "origin/" + BRANCH]).decode().strip()
    # 提交信息可用环境变量覆盖，默认给一条通用说明
    msg = os.environ.get("GHPAGES_MSG",
                         "同步单文件版（index.single.html 的构建产物）") + "\n"
    commit = git(["commit-tree", tree, "-p", parent], inp=msg.encode("utf-8")).decode().strip()
    print("新 commit = " + commit + "  (parent " + parent + ")")

    git(["update-ref", "refs/heads/" + BRANCH, commit])
    print("本地 ref " + BRANCH + " -> " + commit)


if __name__ == "__main__":
    main()

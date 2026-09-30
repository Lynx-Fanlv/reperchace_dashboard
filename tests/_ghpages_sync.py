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
  3) mktree 生成新 tree，commit-tree 生成 commit，update-ref 移动 ref
  4) 交由 github-api-push.mjs 推送
"""
import subprocess
import sys
import os

BRANCH = "gh-pages"
FILE = "index.html"


def git(args, inp=None, check=True):
    r = subprocess.run(["git"] + args, input=inp, capture_output=True)
    if check and r.returncode != 0:
        print("ERR git " + " ".join(args))
        print(r.stderr.decode("utf-8", "replace"))
        sys.exit(1)
    return r.stdout


def main():
    # 1) 新 index.html blob
    blob = git(["hash-object", "-w", FILE]).decode().strip()
    print("新 blob = " + blob)

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

    parent = git(["rev-parse", "origin/" + BRANCH]).decode().strip()
    msg = ("同步单文件版（距今列语义着色 + 手动调列宽/行高）\n").encode("utf-8")
    commit = git(["commit-tree", tree, "-p", parent], inp=msg).decode().strip()
    print("新 commit = " + commit + "  (parent " + parent + ")")

    git(["update-ref", "refs/heads/" + BRANCH, commit])
    print("本地 ref " + BRANCH + " -> " + commit)


if __name__ == "__main__":
    main()

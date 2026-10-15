"""gh-pages 重建：以「权威远端 head」为 parent 重造提交（本地 fetch 不通时的兜底）。

为什么需要它：_ghpages_sync.py 在 git fetch 失败时会沿用本地陈旧的 origin/gh-pages，
造出的提交 parent 与远端分叉，推送必被拒。这里先用 api.github.com 取权威 head，再重建。
用 GIT_INDEX_FILE + update-index --cacheinfo 走索引，彻底绕开 mktree 的文本解析坑。
"""
import os, subprocess, json, urllib.request, sys

REPO = r"C:\Users\yym\WorkBuddy\2026-07-23-09-46-32\repurchase_dashboard"
BRANCH = "gh-pages"
SRC = "index.single.html"          # 内容来源：必须是单文件内联版
DST = "index.html"                 # 目标文件名

env = dict(os.environ)
env["PATH"] = "D:\\software\\Git\\cmd;" + env.get("PATH", "")


def git(*a, idx_env=None, inp=None):
    r = subprocess.run(["git"] + list(a), cwd=REPO, capture_output=True,
                       input=inp, env=idx_env or env)
    if r.returncode:
        raise SystemExit("git %s 失败: %s" % (" ".join(a), r.stderr.decode("utf-8", "replace")[:500]))
    return r.stdout.decode("utf-8", "replace").strip()


# ---- 1) 取权威远端 head ----
tok = ""
for line in git("credential", "fill", inp=b"protocol=https\nhost=github.com\n\n").split("\n"):
    if line.startswith("password="):
        tok = line[9:].strip()
if not tok:
    raise SystemExit("未取到 GitHub token")

req = urllib.request.Request(
    "https://api.github.com/repos/Lynx-Fanlv/reperchace_dashboard/git/ref/heads/" + BRANCH,
    headers={"Authorization": "token " + tok, "Accept": "application/vnd.github+json", "User-Agent": "sync"})
remote = json.load(urllib.request.urlopen(req, timeout=30))["object"]["sha"]
print("权威远端 %s = %s" % (BRANCH, remote))
print("本地 origin/%s = %s" % (BRANCH, git("rev-parse", "origin/" + BRANCH)))

# ---- 2) 把本地 ref 修到权威值，保证后续判断可靠 ----
subprocess.run(["git", "update-ref", "refs/remotes/origin/" + BRANCH, remote], cwd=REPO, env=env, check=True)
print("已修正 origin/%s -> %s" % (BRANCH, remote))

# ---- 3) 用临时索引构造 tree ----
tmpidx = os.path.join(REPO, ".git", "_tmp_ghpages_index")
if os.path.exists(tmpidx):
    os.remove(tmpidx)
ienv = dict(env, GIT_INDEX_FILE=tmpidx)

new_blob = git("hash-object", "-w", SRC, idx_env=ienv)
readme_blob = git("rev-parse", remote + ":README.md", idx_env=ienv)
print("blob: %s -> %s (%s 字节)" % (SRC, new_blob, git("cat-file", "-s", new_blob, idx_env=ienv)))
print("blob: README.md 沿用 %s" % readme_blob)

git("update-index", "--add", "--cacheinfo", "100644,%s,README.md" % readme_blob, idx_env=ienv)
git("update-index", "--add", "--cacheinfo", "100644,%s,%s" % (new_blob, DST), idx_env=ienv)
tree = git("write-tree", idx_env=ienv)
print("★ 目视确认 tree 条目（文件名必须干净、无引号无 CR）:")
print(git("ls-tree", tree, idx_env=ienv))

size = int(git("cat-file", "-s", new_blob, idx_env=ienv))
if size < 1_000_000:
    raise SystemExit("拒绝发布：%s 仅 %d 字节，疑似多文件版混入" % (SRC, size))

msg = "build(gh-pages): 同步单文件版 index.html（修复回传表导出/未购药原因点选不保留）"
commit = git("commit-tree", tree, "-p", remote, "-m", msg, idx_env=ienv)
print("新 commit = %s（parent %s）" % (commit, remote))
git("update-ref", "refs/heads/" + BRANCH, commit)
print("本地 %s -> %s" % (BRANCH, git("rev-parse", BRANCH)))

os.remove(tmpidx)
print("已清理临时索引")
print("PARENT_OK=%s" % remote)

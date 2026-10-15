import os, subprocess, sys
NODE = r"C:\Users\yym\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
# 个别测试用 jsdom（机制级验证，如 _test_nulkey.js）；jsdom 装在 Node 隔离工作区里，
# 不设 NODE_PATH 会 require 失败。这里统一注入，缺失时测试内部会降级跳过。
ENV = dict(os.environ)
ENV["NODE_PATH"] = r"C:\Users\yym\.workbuddy\binaries\node\workspace\node_modules"
root = os.getcwd()
tests = sorted(f for f in os.listdir("tests") if f.startswith("_test_") and f.endswith(".js"))
print("共 %d 个测试脚本\n" % len(tests))
bad = []
for f in tests:
    r = subprocess.run([NODE, os.path.join("tests", f)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace", env=ENV)
    out = (r.stdout or "") + (r.stderr or "")
    last = ""
    for line in (r.stdout or "").splitlines():
        if line.startswith("通过") or "通过 " in line:
            last = line.strip()
    status = "OK  " if r.returncode == 0 else "FAIL"
    if r.returncode != 0:
        bad.append(f)
    print("%s %-34s %s" % (status, f, last))
print()
if bad:
    print("失败脚本 %d 个：" % len(bad))
    for f in bad:
        print("  " + f)
    sys.exit(1)
print("全部通过")

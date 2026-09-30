import os, subprocess, sys
NODE = r"C:\Users\yym\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
root = os.getcwd()
tests = sorted(f for f in os.listdir("tests") if f.startswith("_test_") and f.endswith(".js"))
print("共 %d 个测试脚本\n" % len(tests))
bad = []
for f in tests:
    r = subprocess.run([NODE, os.path.join("tests", f)], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
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

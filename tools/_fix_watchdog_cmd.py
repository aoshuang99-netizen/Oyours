# 修复 MSCMS_Watchdog.cmd 硬编码 node 路径导致的静默自启失败
# 2026-09-15：原脚本写死 node\versions\22.22.2-2\node.exe，该目录早已不存在
#   → 开机自启每次都是 ENOENT 静默失败 → 看门狗从未运行
#   → 3005/3010/3012/3013/8080 无人守护、出口层无人守护。
# 修法：不再自己解析 node，改为调用唯一权威入口 _start_services.ps1（内含正确的
#   semver 版 node 探测 + 全局互斥体，重复调用安全）。
import io, os, sys

STARTUP = os.path.join(os.environ['APPDATA'], 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
TARGET = os.path.join(STARTUP, 'MSCMS_Watchdog.cmd')

CONTENT = (
    "@echo off\r\n"
    "rem ======================================================================\r\n"
    "rem MSCMS v14 \u5168\u94fe\u8def\u770b\u95e8\u72d7\uff08\u5f00\u673a\u81ea\u542f\uff09\r\n"
    "rem\r\n"
    "rem 2026-09-15 \u4fee\u590d\uff1a\u65e7\u7248\u786c\u7f16\u7801 node \u8def\u5f84\r\n"
    "rem   set NODE=...\\node\\versions\\22.22.2-2\\node.exe\r\n"
    "rem   \u8be5\u7248\u672c\u76ee\u5f55\u5df2\u4e0d\u5b58\u5728\uff08\u73b0\u53ea\u6709 22.22.2-3\uff09\r\n"
    "rem   \u21d2 \u6bcf\u6b21\u5f00\u673a\u90fd\u662f ENOENT \u9759\u9ed8\u5931\u8d25\uff0c\u770b\u95e8\u72d7\u4ece\u672a\u771f\u6b63\u8dd1\u8d77\u6765\u3002\r\n"
    "rem   \u8fd9\u4e0e mscms-watchdog.js \u5185\u90e8 09-14 \u4fee\u7684\u662f\u540c\u4e00\u7c7b bug\uff0c\u5f53\u65f6\u53ea\u4fee\u4e86 js\u3001\u6f0f\u4e86\u8fd9\u4e2a .cmd \u5916\u5c42\u3002\r\n"
    "rem\r\n"
    "rem \u73b0\u6539\u4e3a\uff1a\u4e0d\u518d\u81ea\u5df1\u89e3\u6790 node\uff0c\u76f4\u63a5\u8c03\u7528\u552f\u4e00\u6743\u5a01\u5165\u53e3 _start_services.ps1\uff1a\r\n"
    "rem   \u5b83\u5185\u542b\u6b63\u786e\u7684 semver \u7248 node \u63a2\u6d4b\uff0c\u5e76\u6301\u5168\u5c40\u4e92\u65a5\u4f53\uff0c\u91cd\u590d\u8c03\u7528\u5b89\u5168\u3002\r\n"
    "rem   \u770b\u95e8\u72d7\u672c\u4f53\u7531 _start_services.ps1 \u7684 Start-Watchdog \u62c9\u8d77\uff08\u5355\u5b9e\u4f8b\u9501 :3011\uff09\u3002\r\n"
    "rem ======================================================================\r\n"
    "\r\n"
    "set PS=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\r\n"
    "\"%PS%\" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "
    "\"C:\\Users\\AS\\WorkBuddy\\2026-06-13-19-42-19\\_start_services.ps1\"\r\n"
    "exit /b 0\r\n"
)

def main():
    if not os.path.isdir(STARTUP):
        print('FAIL 找不到 Startup 目录: ' + STARTUP); return 1
    if not os.path.isfile(TARGET):
        print('FAIL 找不到目标文件: ' + TARGET); return 1
    bak = TARGET + '.bak-20260915'
    if not os.path.exists(bak):
        with open(TARGET, 'rb') as f: old = f.read()
        with open(bak, 'wb') as f: f.write(old)
        print('已备份 -> ' + os.path.basename(bak) + ' (%d bytes)' % len(old))
    else:
        print('备份已存在，跳过备份')
    # 必须无 BOM 写入：cmd.exe 会把 BOM 字节当成命令的一部分而报错
    with open(TARGET, 'wb') as f:
        f.write(CONTENT.encode('utf-8'))
    print('已写入 %s (%d bytes, no BOM)' % (os.path.basename(TARGET), len(CONTENT.encode('utf-8'))))
    with open(TARGET, 'rb') as f:
        head = f.read(3)
    print('BOM 检查: ' + ('OK 无 BOM' if head != b'\xef\xbb\xbf' else 'FAIL 含 BOM'))
    return 0

sys.exit(main())

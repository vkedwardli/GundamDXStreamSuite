# Only changes this console's input mode; does not modify user/registry settings.
# Legacy console selection can suspend console applications while logs are read.
try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StreamConsoleMode {
    [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);
    [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr handle, uint mode);
}
'@
    $inputHandle = [StreamConsoleMode]::GetStdHandle(-10)
    [uint32]$inputMode = 0
    if ([StreamConsoleMode]::GetConsoleMode($inputHandle, [ref]$inputMode)) {
        # ENABLE_EXTENDED_FLAGS, without ENABLE_QUICK_EDIT_MODE.
        if (-not [StreamConsoleMode]::SetConsoleMode($inputHandle, (($inputMode -bor 0x80) -band (-bnot 0x40)))) {
            Write-Warning "Could not disable QuickEdit. If console selection pauses the app, press Esc."
        }
    }
} catch {
    Write-Warning "Could not configure console selection mode: $_"
}

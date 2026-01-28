$code = @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32 {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    }
"@
Add-Type -TypeDefinition $code

$maxRetries = 10
$retryDelay = 500

for ($i = 0; $i -lt $maxRetries; $i++) {
    $p = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*Streaming Control*" } | Select-Object -First 1

    if ($p) {
        Write-Host "Found Chrome process: $($p.Id). Attempting to force focus..."
        $hwnd = $p.MainWindowHandle
        
        # 9 = SW_RESTORE (Restores window if minimized)
        # 5 = SW_SHOW (Activates the window and displays it in its current size and position)
        [Win32]::ShowWindow($hwnd, 9) 
        [Win32]::SetForegroundWindow($hwnd)
        [Win32]::SwitchToThisWindow($hwnd, $true)
        
        Write-Host "Focus commands sent."
        exit 0
    }
    
    Write-Host "Window not found yet. Retrying in $($retryDelay)ms... ($($i+1)/$maxRetries)"
    Start-Sleep -Milliseconds $retryDelay
}

Write-Host "Failed to find Chrome window after retries."
exit 1
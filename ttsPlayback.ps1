# Use the same native Windows MCI player as edge-playback, reporting when Play succeeds.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CaptionAudio {
    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    public static extern int mciSendString(string command, StringBuilder result, int size, IntPtr callback);
}
'@

function Invoke-Mci([string]$Command) {
    $result = New-Object System.Text.StringBuilder 256
    $code = [CaptionAudio]::mciSendString($Command, $result, 256, [IntPtr]::Zero)
    if ($code -ne 0) { throw "MCI playback failed ($code)" }
    return $result.ToString()
}

try {
    $null = Invoke-Mci ('open "{0}" type mpegvideo alias captionAudio' -f $env:GDX_TTS_AUDIO_FILE)
    $null = Invoke-Mci 'set captionAudio time format milliseconds'
    $duration = Invoke-Mci 'status captionAudio length'
    $null = Invoke-Mci 'play captionAudio'
    [Console]::Out.WriteLine('GDX_TTS_STARTED:' + $duration)
    [Console]::Out.Flush()
    while ((Invoke-Mci 'status captionAudio mode') -eq 'playing') {
        Start-Sleep -Milliseconds 100
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
} finally {
    try { $null = Invoke-Mci 'close captionAudio' } catch { }
}

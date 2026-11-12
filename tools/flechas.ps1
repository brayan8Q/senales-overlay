# Flechas para Pocket Option:  IZQUIERDA = Buy (Shift+W)   DERECHA = Sell (Shift+S)
#
# Solo actua cuando la ventana que esta al frente es la de Pocket Option (por el titulo de la
# ventana). En cualquier otra ventana las flechas funcionan normal.
#
# Este programa NO decide nada ni opera solo: cada orden sale de una tecla que aprietas tu, y lo
# que hace es convertirla en el atajo propio de la plataforma (hay que tener "Activate hotkeys"
# encendido en Pocket Option).
#
# Protecciones:
#   - Mantener la flecha apretada cuenta como UNA sola pulsacion (no abre varias operaciones).
#   - Entre una orden y la siguiente deben pasar al menos 400 ms.
#   - F8 lo pausa y lo reanuda (suena un tono: agudo = activo, grave = en pausa).
#   - Icono junto al reloj: clic derecho -> Pausar / Salir.

# Titulos de ventana en los que se activan las flechas (basta con que el titulo contenga uno).
$Titles = @('The Most Innovative Trading Platform', 'Pocket Option', 'PocketOption')

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class Flechas
{
    const int WH_KEYBOARD_LL = 13;
    const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
    const int VK_LEFT = 0x25, VK_RIGHT = 0x27, VK_F8 = 0x77, VK_SHIFT = 0x10, VK_CONTROL = 0x11, VK_MENU = 0x12, VK_LWIN = 0x5B, VK_RWIN = 0x5C;
    const uint LLKHF_INJECTED = 0x10;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const int MIN_GAP_MS = 400;

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("kernel32.dll")] static extern bool Beep(uint freq, uint duration);

    static IntPtr hook = IntPtr.Zero;
    static HookProc proc = Callback; // se guarda la referencia para que no la recoja el recolector
    static string[] titles = new string[0];
    static bool leftDown, rightDown;
    static long lastOrder;
    public static bool Paused;
    public static int Buys, Sells;
    public static event Action Changed;

    public static void Start(string[] windowTitles)
    {
        titles = windowTitles;
        using (var process = Process.GetCurrentProcess())
        using (var module = process.MainModule)
            hook = SetWindowsHookEx(WH_KEYBOARD_LL, proc, GetModuleHandle(module.ModuleName), 0);
        if (hook == IntPtr.Zero) throw new Exception("No se pudo instalar el atajo de teclado (error " + Marshal.GetLastWin32Error() + ")");
    }

    public static void Stop()
    {
        if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
        hook = IntPtr.Zero;
    }

    public static void Toggle()
    {
        Paused = !Paused;
        Beep(Paused ? 400u : 1000u, 120);
        if (Changed != null) Changed();
    }

    static bool Down(int vk) { return (GetAsyncKeyState(vk) & 0x8000) != 0; }

    public static bool OnTarget()
    {
        var text = new StringBuilder(512);
        GetWindowText(GetForegroundWindow(), text, text.Capacity);
        string title = text.ToString();
        foreach (string t in titles) if (title.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0) return true;
        return false;
    }

    static void Send(byte letter)
    {
        keybd_event((byte)VK_SHIFT, 0, 0, UIntPtr.Zero);
        keybd_event(letter, 0, 0, UIntPtr.Zero);
        keybd_event(letter, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event((byte)VK_SHIFT, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    static IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var data = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            int message = wParam.ToInt32();
            bool down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            bool up = message == WM_KEYUP || message == WM_SYSKEYUP;
            bool injected = (data.flags & LLKHF_INJECTED) != 0;
            int vk = (int)data.vkCode;

            if (!injected && vk == VK_F8 && down && OnTarget()) { Toggle(); return (IntPtr)1; }

            if (!injected && (vk == VK_LEFT || vk == VK_RIGHT))
            {
                bool left = vk == VK_LEFT;
                bool wasDown = left ? leftDown : rightDown;
                if (up)
                {
                    if (left) leftDown = false; else rightDown = false;
                    if (wasDown) return (IntPtr)1; // la pulsacion se la quedo este programa: tambien su suelta
                }
                else if (down)
                {
                    if (wasDown) return (IntPtr)1; // tecla mantenida: no repite la orden
                    bool modifiers = Down(VK_SHIFT) || Down(VK_CONTROL) || Down(VK_MENU) || Down(VK_LWIN) || Down(VK_RWIN);
                    if (!Paused && !modifiers && OnTarget())
                    {
                        if (left) leftDown = true; else rightDown = true;
                        long now = Environment.TickCount;
                        if (now - lastOrder >= MIN_GAP_MS)
                        {
                            lastOrder = now;
                            Send(left ? (byte)'W' : (byte)'S'); // izquierda = Buy, derecha = Sell
                            if (left) Buys++; else Sells++;
                            if (Changed != null) Changed();
                        }
                        return (IntPtr)1;
                    }
                }
            }
        }
        return CallNextHookEx(hook, nCode, wParam, lParam);
    }
}
'@

# Comprobacion sin instalar nada: compila y sale (para probar que el archivo esta bien).
if ($args -contains '-Check') {
  Write-Output ('OK: compila. Ventana de Pocket Option al frente ahora: ' + [Flechas]::OnTarget())
  exit 0
}

# Una sola copia a la vez.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'FlechasPocketOption', [ref]$created)
if (-not $created) { exit 0 }

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Application
$icon.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$pauseItem = $menu.Items.Add('Pausar (F8)')
$exitItem = $menu.Items.Add('Salir')
$icon.ContextMenuStrip = $menu

$refresh = {
  $state = if ([Flechas]::Paused) { 'EN PAUSA' } else { 'activo' }
  $icon.Text = "Flechas Pocket Option: $state | Buy $([Flechas]::Buys) / Sell $([Flechas]::Sells)"
  $pauseItem.Text = if ([Flechas]::Paused) { 'Reanudar (F8)' } else { 'Pausar (F8)' }
}
$pauseItem.add_Click({ [Flechas]::Toggle(); & $refresh })
$exitItem.add_Click({ [System.Windows.Forms.Application]::Exit() })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({ & $refresh })
$timer.Start()

[Flechas]::Start($Titles)
& $refresh
$icon.ShowBalloonTip(4000, 'Flechas Pocket Option', 'Activo. Izquierda = Buy, Derecha = Sell. F8 pausa. Solo en la ventana de Pocket Option.', [System.Windows.Forms.ToolTipIcon]::Info)
try {
  [System.Windows.Forms.Application]::Run()
} finally {
  [Flechas]::Stop()
  $icon.Visible = $false
  $icon.Dispose()
  $mutex.ReleaseMutex()
}

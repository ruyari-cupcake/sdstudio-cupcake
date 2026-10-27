'use strict';

// Native OS input preserves Electron's non-client drag hit testing. The caller
// owns the display, Electron process and disposable profile used by the smoke.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const COMMAND_TIMEOUT_MS = 20_000;
const KEY_CODES = {
  Escape: [0x1b],
  'Ctrl+A': [0x11, 0x41],
  Backspace: [0x08],
  Tab: [0x09],
  'Shift+Tab': [0x10, 0x09],
  Enter: [0x0d],
  Space: [0x20],
  ArrowLeft: [0x25],
  ArrowUp: [0x26],
  ArrowRight: [0x27],
  ArrowDown: [0x28],
};
const X11_KEYS = {
  Escape: 'Escape',
  'Ctrl+A': 'ctrl+a',
  Backspace: 'BackSpace',
  Tab: 'Tab',
  'Shift+Tab': 'shift+Tab',
  Enter: 'Return',
  Space: 'space',
  ArrowLeft: 'Left',
  ArrowUp: 'Up',
  ArrowRight: 'Right',
  ArrowDown: 'Down',
};

// Keep both union members: SendInput validates INPUT's native size/alignment.
// Microsoft Learn: SendInput, INPUT, KEYBDINPUT, MOUSEINPUT, ClientToScreen.
const WINDOWS_SOURCE = [
  'using System;',
  'using System.Collections.Generic;',
  'using System.ComponentModel;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class CupcakeNativeInput {',
  '  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x; public int y; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left; public int top; public int right; public int bottom; }',
  '  [StructLayout(LayoutKind.Sequential)] public struct MouseInput {',
  '    public int dx; public int dy; public uint data; public uint flags;',
  '    public uint time; public IntPtr extra;',
  '  }',
  '  [StructLayout(LayoutKind.Sequential)] public struct KeyInput {',
  '    public ushort key; public ushort scan; public uint flags;',
  '    public uint time; public IntPtr extra;',
  '  }',
  '  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {',
  '    [FieldOffset(0)] public MouseInput mouse;',
  '    [FieldOffset(0)] public KeyInput keyboard;',
  '  }',
  '  [StructLayout(LayoutKind.Sequential)] public struct Input {',
  '    public uint type; public InputUnion value;',
  '  }',
  '  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] inputs, int size);',
  '  [DllImport("user32.dll", SetLastError=true)] static extern bool ClientToScreen(IntPtr window, ref Point point);',
  '  [DllImport("user32.dll", SetLastError=true)] static extern bool SetCursorPos(int x, int y);',
  '  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);',
  '  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", SetLastError=true)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);',
  '  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);',
  '  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);',
  '  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);',
  '  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);',
  '  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rectangle);',
  '  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rectangle);',
  '  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);',
  '  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);',
  '  [DllImport("user32.dll", EntryPoint="GetClassNameW", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int size);',
  '  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] static extern int GetWindowLong(IntPtr window, int index);',
  '  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();',
  '  static string DescribeWindow(IntPtr window) {',
  '    uint pid; GetWindowThreadProcessId(window, out pid);',
  '    var name = new StringBuilder(256); GetClassName(window, name, name.Capacity);',
  '    string processName = "unavailable";',
  '    try { using (var process = System.Diagnostics.Process.GetProcessById((int)pid)) { processName = process.ProcessName; } } catch {}',
  '    Rect bounds; bool hasBounds = GetWindowRect(window, out bounds);',
  '    Rect client; bool hasClient = GetClientRect(window, out client);',
  '    uint style = unchecked((uint)GetWindowLong(window, -16));',
  '    uint extendedStyle = unchecked((uint)GetWindowLong(window, -20));',
  '    return "hwnd=" + window + ",pid=" + pid + ",process=" + processName + ",class=" + name',
  '      + ",bounds=" + (hasBounds ? bounds.left + ":" + bounds.top + ":" + bounds.right + ":" + bounds.bottom : "unavailable")',
  '      + ",client=" + (hasClient ? client.left + ":" + client.top + ":" + client.right + ":" + client.bottom : "unavailable")',
  '      + ",visible=" + IsWindowVisible(window) + ",iconic=" + IsIconic(window)',
  '      + ",style=0x" + style.ToString("X") + ",exStyle=0x" + extendedStyle.ToString("X") + ",topmost=" + ((extendedStyle & 0x8) != 0);',
  '  }',
  '  static void Send(Input[] inputs) {',
  '    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));',
  '    if (sent != inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error(), "Native input was not fully delivered");',
  '  }',
  '  static void VerifyOwner(IntPtr window, uint expectedPid) {',
  '    uint pid;',
  '    if (!IsWindow(window)) throw new InvalidOperationException("Owned Electron window no longer exists");',
  '    GetWindowThreadProcessId(window, out pid);',
  '    if (pid != expectedPid) throw new InvalidOperationException("Native window belongs to a different process");',
  '  }',
  '  public static void Prepare(IntPtr window, uint expectedPid, bool requireForeground) {',
  '    SetProcessDPIAware();',
  '    VerifyOwner(window, expectedPid);',
  // Every action follows the owned Electron window.focus() request. Its JS
  // return does not acknowledge Windows activation across native input queues.
  // Wait for WM_NULL before the click's owned-point hit test as well as keys.
  // An exposed inactive window can still activate through the one real click;
  // only keyboard input requires foreground ownership before delivery.
  '    uint pid;',
  '    bool requested = requireForeground && SetForegroundWindow(window);',
  // https://devblogs.microsoft.com/oldnewthing/20161118-00/?p=94745
  '    UIntPtr acknowledged;',
  '    if (SendMessageTimeout(window, 0, UIntPtr.Zero, IntPtr.Zero, 0x22, 5000, out acknowledged) == IntPtr.Zero)',
  '      throw new InvalidOperationException("Owned Electron window did not acknowledge native activation");',
  '    VerifyOwner(window, expectedPid);',
  '    if (!requireForeground) return;',
  '    IntPtr foreground = GetForegroundWindow();',
  '    GetWindowThreadProcessId(foreground, out pid);',
  '    if (pid != expectedPid) throw new InvalidOperationException("Owned Electron process could not acquire native focus (requested=" + requested + ", foregroundPid=" + pid + ", foregroundHwnd=" + foreground + ")");',
  '  }',
  '  public static void Click(IntPtr window, int x, int y) {',
  '    Point point = new Point { x=x, y=y };',
  '    if (!ClientToScreen(window, ref point)) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '    IntPtr hit = WindowFromPoint(point);',
  '    IntPtr hitRoot = GetAncestor(hit, 2);',
  '    IntPtr ownedRoot = GetAncestor(window, 2);',
  '    if (hitRoot != ownedRoot) {',
  '      uint hitPid;',
  '      GetWindowThreadProcessId(hit, out hitPid);',
  '      throw new InvalidOperationException("Native click point is covered or outside the owned window (client=" + x + "," + y + ", screen=" + point.x + "," + point.y + ", hitHwnd=" + hit + ", hitRoot=" + hitRoot + ", hitPid=" + hitPid + ", ownedHwnd=" + window + ", ownedRoot=" + ownedRoot + "; owned={" + DescribeWindow(window) + "}; hit={" + DescribeWindow(hit) + "}; hitRoot={" + DescribeWindow(hitRoot) + "}; foreground={" + DescribeWindow(GetForegroundWindow()) + "})");',
  '    }',
  '    if (!SetCursorPos(point.x, point.y)) throw new Win32Exception(Marshal.GetLastWin32Error());',
  '    Input down = new Input { type=0 }; down.value.mouse.flags=0x0002;',
  '    Input up = new Input { type=0 }; up.value.mouse.flags=0x0004;',
  '    Send(new Input[] { down, up });',
  '  }',
  // SendInput inserts mouse events asynchronously. Observe native activation
  // without extra clicks or focus requests, rechecking the owner every time.
  // https://learn.microsoft.com/en-us/windows/win32/inputdev/about-mouse-input
  '  public static void WaitForForeground(IntPtr window, uint expectedPid) {',
  '    var elapsed = System.Diagnostics.Stopwatch.StartNew();',
  '    while (true) {',
  '      VerifyOwner(window, expectedPid);',
  '      uint pid;',
  '      IntPtr foreground = GetForegroundWindow();',
  '      GetWindowThreadProcessId(foreground, out pid);',
  '      if (pid == expectedPid) return;',
  '      if (elapsed.ElapsedMilliseconds >= 5000)',
  '        throw new InvalidOperationException("Native click did not activate owned Electron window (foregroundPid=" + pid + ", foregroundHwnd=" + foreground + ")");',
  '      System.Threading.Thread.Sleep(25);',
  '    }',
  '  }',
  '  static Input Key(ushort key, ushort scan, uint flags) {',
  '    Input input = new Input { type=1 };',
  '    input.value.keyboard = new KeyInput { key=key, scan=scan, flags=flags };',
  '    return input;',
  '  }',
  '  public static void Keys(ushort[] keys) {',
  '    List<Input> inputs = new List<Input>();',
  '    foreach (ushort key in keys) inputs.Add(Key(key, 0, 0));',
  '    for (int i=keys.Length-1; i>=0; i--) inputs.Add(Key(keys[i], 0, 0x0002));',
  '    Send(inputs.ToArray());',
  '  }',
  '  public static void Text(string text) {',
  '    List<Input> inputs = new List<Input>();',
  '    foreach (char c in text) {',
  '      inputs.Add(Key(0, c, 0x0004));',
  '      inputs.Add(Key(0, c, 0x0004 | 0x0002));',
  '    }',
  '    if (inputs.Count > 0) Send(inputs.ToArray());',
  '  }',
  '}',
].join('\n');

function windowsInput(payload) {
  // Payload is data, never interpolated PowerShell. EncodedCommand is UTF-16LE.
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64',
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -TypeDefinition @'",
    WINDOWS_SOURCE,
    "'@",
    "$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
      encodedPayload +
      "')) | ConvertFrom-Json",
    '$window = [IntPtr]::new([Int64]$payload.handle)',
    "[CupcakeNativeInput]::Prepare($window, [uint32]$payload.pid, ($payload.action -ne 'click'))",
    'switch ($payload.action) {',
    "  'click' { [CupcakeNativeInput]::Click($window, [int]$payload.x, [int]$payload.y); [CupcakeNativeInput]::WaitForForeground($window, [uint32]$payload.pid) }",
    "  'key' { [CupcakeNativeInput]::Keys([System.UInt16[]]$payload.keys) }",
    "  'type' { [CupcakeNativeInput]::Text([string]$payload.text) }",
    "  default { throw 'Unknown native input action' }",
    '}',
    "'NATIVE_INPUT_OK'",
  ].join('\n');
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { encoding: 'utf8', windowsHide: true, timeout: COMMAND_TIMEOUT_MS },
  );
  assert(
    output.includes('NATIVE_INPUT_OK'),
    'Windows native input receipt is missing',
  );
}

async function createNativeInput(application, page) {
  assert(
    ['linux', 'win32'].includes(process.platform),
    'Native input smoke supports Linux X11 and Windows',
  );
  const owner = await application.browserWindow(page);
  const identity = await owner.evaluate((window) => {
    const handle = window.getNativeWindowHandle();
    return {
      handle:
        handle.length >= 8
          ? handle.readBigUInt64LE(0).toString()
          : handle.readUInt32LE(0).toString(),
      pid: process.pid,
      parentPid: process.ppid,
    };
  });
  // Playwright 1.61 launches Windows Electron through an owned cmd.exe.
  // Accept only that launcher's direct child, while Win32 still verifies the
  // native HWND and foreground window against the actual Electron main PID.
  const launcherPid = application.process().pid;
  assert(
    identity.pid === launcherPid ||
      (process.platform === 'win32' && identity.parentPid === launcherPid),
    'Native window does not belong to the owned launcher or its Windows child',
  );
  if (process.platform === 'win32') {
    // The CI runner's foreground console can cover a restarted fixture even
    // after moveTop()/focus(). Expose only this verified, disposable window;
    // the real click must still hit its HWND and acquire native foreground.
    await owner.evaluate((window) => window.setAlwaysOnTop(true));
  }
  async function focus() {
    assert(!page.isClosed(), 'Owned page has closed');
    await owner.evaluate((window) => {
      // A restarted window may be behind the CI host's other process even
      // after focus(). Expose only our owned window before native hit testing.
      if (process.platform === 'win32') window.moveTop();
      window.focus();
    });
  }
  function x11(args) {
    return execFileSync(
      'xdotool',
      ['windowfocus', '--sync', identity.handle, ...args],
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
      },
    );
  }
  async function clickAt(x, y) {
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
      scale: devicePixelRatio,
    }));
    assert(
      Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= 0 &&
        y >= 0 &&
        x < viewport.width &&
        y < viewport.height,
      'Native click is outside the page viewport',
    );
    await focus();
    const point = {
      x: Math.round(x * viewport.scale),
      y: Math.round(y * viewport.scale),
    };
    if (process.platform === 'linux') {
      x11([
        'mousemove',
        '--sync',
        '--window',
        identity.handle,
        String(point.x),
        String(point.y),
        'click',
        '1',
      ]);
    } else windowsInput({ ...identity, action: 'click', ...point });
  }
  return {
    kind: process.platform === 'linux' ? 'linux-xtest' : 'windows-sendinput',
    processIdentity: {
      launcherPid,
      mainPid: identity.pid,
      parentPid: identity.parentPid,
    },
    async click(locator) {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      assert(
        box && box.width > 0 && box.height > 0,
        'Native click target has no visible area',
      );
      await clickAt(box.x + box.width / 2, box.y + box.height / 2);
    },
    clickAt,
    async key(key) {
      assert(
        Object.hasOwn(KEY_CODES, key),
        'Unsupported native smoke key: ' + key,
      );
      await focus();
      if (process.platform === 'linux')
        x11(['key', '--clearmodifiers', X11_KEYS[key]]);
      else windowsInput({ ...identity, action: 'key', keys: KEY_CODES[key] });
    },
    async type(text) {
      assert.equal(typeof text, 'string');
      await focus();
      if (process.platform === 'linux')
        x11(['type', '--clearmodifiers', '--delay', '0', '--', text]);
      else windowsInput({ ...identity, action: 'type', text });
    },
  };
}

module.exports = { createNativeInput };

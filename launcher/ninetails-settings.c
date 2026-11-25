/*
 * NinetailsSettings.exe — opens the Ninetails settings page in Firefox.
 *
 * It asks Firefox to open http://ninetails.localhost/settings. The Ninetails
 * extension spots that address before it loads and swaps in its own settings
 * page. *.localhost always means "this computer", so nothing leaves the
 * machine. Build: see launcher/build.sh (cross-compile) or build.ps1 (Windows).
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <shellapi.h>

/* Built twice: NinetailsSettings.exe (default) and NinetailsTidy.exe (-DNT_TIDY). */
#ifdef NT_TIDY
static const wchar_t *URL = L"http://ninetails.localhost/tidy";
#else
static const wchar_t *URL = L"http://ninetails.localhost/settings";
#endif

static BOOL try_open(const wchar_t *exe) {
    HINSTANCE r = ShellExecuteW(NULL, L"open", exe, URL, NULL, SW_SHOWNORMAL);
    return (INT_PTR)r > 32;
}

int WINAPI wWinMain(HINSTANCE h, HINSTANCE p, PWSTR cmd, int show) {
    (void)h; (void)p; (void)cmd; (void)show;

    /* 1. Registered App Path (normal installs). */
    if (try_open(L"firefox.exe")) return 0;

    /* 2. Common install locations, including Developer Edition and Nightly. */
    static const wchar_t *rel[] = {
        L"\\Mozilla Firefox\\firefox.exe",
        L"\\Firefox Developer Edition\\firefox.exe",
        L"\\Firefox Nightly\\firefox.exe",
    };
    static const wchar_t *roots[] = { L"ProgramFiles", L"ProgramFiles(x86)", L"LOCALAPPDATA" };
    wchar_t base[MAX_PATH], full[MAX_PATH * 2];
    for (int i = 0; i < 3; i++) {
        DWORD n = GetEnvironmentVariableW(roots[i], base, MAX_PATH);
        if (n == 0 || n >= MAX_PATH) continue;
        for (int j = 0; j < 3; j++) {
            lstrcpyW(full, base);
            if (i == 2) lstrcatW(full, L"\\Programs");
            lstrcatW(full, rel[j]);
            if (GetFileAttributesW(full) != INVALID_FILE_ATTRIBUTES && try_open(full)) return 0;
        }
    }

    MessageBoxW(NULL,
        L"Couldn't find Firefox.\n\nOpen Firefox and go to\nhttp://ninetails.localhost/settings\n"
        L"(or click the Ninetails toolbar button → Settings).",
        L"Ninetails", MB_OK | MB_ICONINFORMATION);
    return 1;
}

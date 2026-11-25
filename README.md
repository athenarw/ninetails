# Ninetails

**Tab housekeeping for Firefox, for people who keep hundreds of tabs open.**

Keeping tabs open is useful: whatever you were reading is still there when
you need it. But after a few weeks it turns into dozens of windows with
everything mixed together, the same page open five times, and a browser that
slows to a crawl.

Ninetails keeps the useful part and handles the mess. You give your windows
names, like *Email*, *Research*, *Code* or *Random*, and say which websites
belong in each. Ninetails then quietly keeps things where they belong.

## What it does

- **Files tabs into the right window.** Open a GitHub link from your email,
  and a few minutes later it moves to your *Code* window. You choose how long
  it waits.
- **Closes duplicates.** If the same page is open twice and one copy hasn't
  been used in a while, the extra copy is closed.
- **Keeps each window in order.** Tabs from the same site sit together, in
  the order you choose.
- **Clears out the clutter.** It closes throwaway pages like Zoom's "launch
  meeting" tabs and empty New Tab pages after 10 minutes. You can also have
  it close tabs in any window that haven't been used for days.
- **Labels your windows.** Each window's title bar shows its name, for
  example `[Research] A paper title — Mozilla Firefox`, so you can tell them
  apart in the taskbar.
- **Remembers which window is which** after you restart Firefox.
- **Profiles.** Keep one setup for work and another for home, and switch
  between them in one click.

Nothing is ever lost: every tab Ninetails closes is listed in its settings
with a **Reopen** button.

### What it leaves alone

Ninetails never touches:

- pinned tabs;
- the tab you're currently looking at in each window;
- tabs playing sound;
- tabs in Firefox tab groups (you can change this);
- a tab you've dragged somewhere yourself;
- sites you put on its "never touch" list.

## Privacy

Ninetails runs entirely inside Firefox on your computer.

- It never sends anything anywhere and contains no tracking or analytics.
- It can see the addresses and titles of your tabs, because it needs them to
  sort. It cannot read what's on the pages.
- Your settings are stored in Firefox on your computer.
- It doesn't run in private windows unless you allow it.

**Permissions it asks for:**

| Permission | Why |
|---|---|
| Access browser tabs | to see tab addresses and titles, and to move, sort and close tabs |
| Storage | to save your settings |
| Sessions | to remember each window's name across restarts and to reopen closed tabs |
| Alarms | to run a check about once a minute |
| Menus | for the right-click **Ninetails** menu |

## Installing

1. Download the latest `ninetails-x.y.z.xpi` from this repository's
   **Releases** page.
2. In Firefox, open the menu → **Add-ons and themes** (or go to
   `about:addons`).
3. Click the gear icon → **Install Add-on From File…** and choose the file
   you downloaded.

Requires Firefox 142 or newer. To update, install a newer `.xpi` the same
way. Your settings are kept.

## Getting started

1. **Open the settings:** click the Ninetails button in the toolbar, then
   **Settings**.
2. **Look at your windows.** Ninetails starts with an example setup: Email,
   Research, Code, Overview, Random and others. Rename, delete or add
   windows to suit how you work, and add the websites that belong in each.
3. **Tell it which Firefox window is which.** On each window's card, choose
   one of your open Firefox windows or click **Open window**. You can also
   click the toolbar button inside any window and pick **This Firefox window
   is…**. Ninetails often guesses this on its own from what's open.
4. **Let it work.** Misplaced tabs move after 10 minutes. If you want it all
   done now, click **Tidy now**.

## Everyday use

**Tidy everything right now:**

- the Tidy icon in the address bar;
- **Alt+Shift+9**;
- **Tidy now** in the toolbar popup or at the top of settings.

**Right-click any tab → Ninetails:**

- **Always send this site to ▸** files this site under a window from now on.
- **Move this tab to (once) ▸** moves just this tab, and Ninetails leaves it
  there.
- **Make this window ▸** names the current window.
- **Leave this tab where it is** keeps Ninetails away from this tab.

**Undo a close:** in settings, scroll to **Closed tabs** and click **Reopen**.

**Pause everything:** use the on/off switch in the toolbar popup or at the
top of settings.

## Settings in more detail

### Windows

Each window has a name, an on/off switch and a list of websites. Windows are
checked from top to bottom, and the first match wins, so put more specific
windows above general ones. You can rename, reorder, merge two windows into
one, or delete them.

Two extra options on each window:

- **Also catch everything no other window claims** makes it the catch-all.
  The example *Random* window is set up this way.
- **Close this window's tabs unused for…** closes that window's tabs once
  you haven't looked at them for the time you choose, for example 3 days for
  *Random*.

### Describing websites

| Write | To match |
|---|---|
| `notion.so` | that site and all its subdomains |
| `docs.google.com/spreadsheets` | a site plus the start of the address |
| `https://www.google.*/search*` | an address pattern, where `*` means anything |
| `file:///*.pdf*` | PDFs opened from your computer |
| `title:Weekly report` | tabs whose title contains that text |
| `about:newtab` | Firefox's own pages (auto-close only) |
| `re:^https://…` | a regular expression, for advanced users |

The **Test a page** box shows where any address would be filed and whether
it would be auto-closed.

### Auto-close

The **Auto-close** section lists pages to close once they've sat unused for a
while (10 minutes by default). It comes set up for Zoom's launch and
post-meeting pages. A Zoom meeting you've joined inside Firefox is not on
the list, so it won't be closed. Add anything else you like, such as
`about:newtab` for empty New Tab pages or `*/whatsnew*` for Firefox's
"What's New" page.

### Behavior

You can change:

- how long a tab waits before moving;
- how long a duplicate must be idle before it closes;
- how tabs are sorted: by window order, by site name, most recently used
  first, or in the order they were opened;
- whether to sort the window you're using;
- whether Ninetails may open new windows;
- how many changes it makes per minute.

### Profiles

A profile is a whole setup: windows, websites and behavior. You can create,
duplicate, rename, delete, export and import profiles. Pick one as the
**default** to use whenever Firefox starts on this computer. Export a
profile on one computer and import it on another to carry your setup over.

## Windows shortcuts (optional)

Two small helper programs come with the source code:

- **NinetailsSettings.exe** opens the Ninetails settings in Firefox.
- **NinetailsTidy.exe** tidies all your windows.

Pin them to the taskbar or Start menu if you like. Windows may warn about
them the first time because they aren't signed. Choose **More info → Run
anyway**. They do nothing except ask Firefox to open a special
`ninetails.localhost` address, which the add-on recognizes.

## Questions

**Will it close something I'm using?**
It never closes the tab you're looking at, pinned tabs or tabs playing
sound. Duplicates and unused tabs only close after the waiting times you set,
and every closed tab can be reopened from **Closed tabs**.

**I moved a tab back and Ninetails moved it again.**
Dragging a tab to another window tells Ninetails to leave it there. If it
keeps happening, right-click the tab → **Ninetails → Leave this tab where it
is**, or adjust that site's window.

**A site is landing in the wrong window.**
Type its address into **Test a page** to see which rule caught it. Then move
the right window higher in the list or make its rule more specific.

**Does it work on Firefox for Android?**
It's built and tested for desktop Firefox.

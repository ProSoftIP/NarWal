// The instructions shown before a recording starts.
//
// The marker lines describe what the capture code does (board #16543):
// right-click marks the element and suppresses the page menu for that
// gesture; Shift + right-click is passed to the page untouched; a
// right-button drag of MIN_BOX_DRAG_PX or more draws a box, Esc cancels it;
// MARK_SHORTCUT marks the focused element. Change them together.

export const MIN_BOX_DRAG_PX = 6;
export const MARK_SHORTCUT = 'Alt+Shift+M';

export const INSTRUCTION_STEPS = [
  {
    id: 'talk',
    title: 'Talk as you go',
    body: 'Say what you see and what you want. NarWal records your voice and what you point at, click, scroll and select.',
  },
  {
    id: 'mark',
    title: 'Right-click to mark one thing',
    body: `Right-click an item to mark it. The page menu does not open. To get the page menu, hold Shift and right-click. With the keyboard, ${MARK_SHORTCUT} marks the item that has focus.`,
  },
  {
    id: 'box',
    title: 'Right-drag to mark an area',
    body: 'Hold the right mouse button and drag to draw a box. Press Esc while you drag to cancel the box.',
  },
  {
    id: 'tab',
    title: 'Only this tab is recorded',
    body: 'You can go to other pages in this tab and the recording continues. Other tabs are not recorded.',
  },
  {
    id: 'private',
    title: 'What is kept private',
    body: 'Text you type is hidden in the recording. Text shown on the page is kept. To leave out part of the page, press Hide areas before you start and click that part. Your voice is recorded as you speak, so do not read secrets aloud.',
  },
  {
    id: 'stop',
    title: 'Stop from the bar at the bottom',
    body: 'A one-line bar shows the recording time. Open Transcript there to check the words. Press Stop when you finish. The recording is saved on this computer.',
  },
];

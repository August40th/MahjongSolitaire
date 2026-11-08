'use strict';
/* Starts the game once the page has loaded. The other files, in the order they are loaded by index.html:
     js/logic.js  - the rules: layout, free tiles, deals, FIND, matches counter, quadruples, tray, undo, shuffle
     js/music.js  - the ambient music engine (synthesis, composer, effects) and the MusicPlayer
     js/ui.js     - screens, drawing and input (menu, game, editors, music settings, touch and pinch zoom)  */
window.addEventListener('load', startMahjong);

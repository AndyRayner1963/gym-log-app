// The one place the app version lives.  Bump it for every release: the
// service worker caches the app files under this version, so a new value
// makes the phone download the new set quietly and use it from the next launch.
// Loaded as a classic script by index.html and by sw.js (importScripts).
self.SWOLE_VERSION = '1.0.0';

const killThese = [];

process.on('exit', _code => {
  // Kill them all
  killThese.forEach(func => {
    if (typeof func === 'function') {
      try {
        func();
      } catch (_err) {
        console.log('Error: Failed to run kill function');
      }
    }
  });
});

export function addToKillQueue(func) {
  killThese.push(func);
}

export function removeFromKillQueue(func) {
  const idx = killThese.indexOf(func);
  if (idx !== -1) {
    killThese.splice(idx, 1);
  }
}

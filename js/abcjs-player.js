(function () {
  'use strict';

  let audioContext;
  let activePlayer;
  let observer;
  const players = new Set();

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '0:00';
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  function observeRemovedPlayers() {
    if (observer || !document.body) return;
    observer = new MutationObserver(() => {
      players.forEach(player => {
        if (!player.host.isConnected) player.destroy();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function mount(host, visualObj, options) {
    if (host._abcjsPlayer) host._abcjsPlayer.destroy();

    host.innerHTML = `
      <div class="abcjs-player" role="group" aria-label="Score player">
        <input class="abcjs-player__progress" type="range" min="0" max="1000" value="0" aria-label="Seek" disabled>
        <div class="abcjs-player__controls">
          <div class="abcjs-player__group">
            <button class="abcjs-player__button abcjs-player__play" type="button" title="Play" aria-label="Play"><i class="fa-solid fa-play" aria-hidden="true"></i></button>
            <button class="abcjs-player__button abcjs-player__restart" type="button" title="Restart" aria-label="Restart"><i class="fa-solid fa-rotate-left" aria-hidden="true"></i></button>
            <span class="abcjs-player__clock">0:00 / 0:00</span>
          </div>
          <div class="abcjs-player__group abcjs-player__settings">
            <button class="abcjs-player__button abcjs-player__mute" type="button" title="Mute" aria-label="Mute"><i class="fa-solid fa-volume-high" aria-hidden="true"></i></button>
            <input class="abcjs-player__volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume">
            <select class="abcjs-player__rate" aria-label="Playback speed" title="Playback speed">
              <option value="0.5">0.5x</option>
              <option value="0.75">0.75x</option>
              <option value="1" selected>1x</option>
              <option value="1.25">1.25x</option>
              <option value="1.5">1.5x</option>
              <option value="2">2x</option>
            </select>
            <button class="abcjs-player__button abcjs-player__loop" type="button" title="Loop" aria-label="Loop" aria-pressed="false"><i class="fa-solid fa-repeat" aria-hidden="true"></i></button>
            <button class="abcjs-player__button abcjs-player__download" type="button" title="Download WAV" aria-label="Download WAV" disabled><i class="fa-solid fa-download" aria-hidden="true"></i></button>
          </div>
        </div>
        <span class="abcjs-player__error" role="alert" hidden></span>
      </div>`;

    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.hidden = true;
    host.appendChild(audio);

    const playButton = host.querySelector('.abcjs-player__play');
    const restartButton = host.querySelector('.abcjs-player__restart');
    const muteButton = host.querySelector('.abcjs-player__mute');
    const loopButton = host.querySelector('.abcjs-player__loop');
    const downloadButton = host.querySelector('.abcjs-player__download');
    const progress = host.querySelector('.abcjs-player__progress');
    const volume = host.querySelector('.abcjs-player__volume');
    const rate = host.querySelector('.abcjs-player__rate');
    const clock = host.querySelector('.abcjs-player__clock');
    const error = host.querySelector('.abcjs-player__error');

    playButton.hidden = options.play === false;
    restartButton.hidden = options.restart === false;
    progress.hidden = options.progress === false;
    rate.hidden = options.warp === false;
    loopButton.hidden = options.loop === false;

    let blobUrl;
    let loadPromise;
    let destroyed = false;

    function updateTime() {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      progress.disabled = !duration;
      progress.value = duration ? Math.round(audio.currentTime / duration * 1000) : 0;
      clock.textContent = `${formatTime(audio.currentTime)} / ${formatTime(duration)}`;
    }

    function updatePlayButton() {
      const label = audio.paused ? 'Play' : 'Pause';
      playButton.title = label;
      playButton.setAttribute('aria-label', label);
      playButton.querySelector('i').className = `fa-solid fa-${audio.paused ? 'play' : 'pause'}`;
    }

    function setLoading(loading) {
      playButton.disabled = loading;
      playButton.title = loading ? 'Loading audio' : 'Play';
      playButton.setAttribute('aria-label', playButton.title);
      playButton.querySelector('i').className = loading ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-play';
    }

    async function prepareAudio() {
      if (blobUrl) return;
      if (!loadPromise) {
        setLoading(true);
        error.hidden = true;
        loadPromise = (async () => {
          const AudioContextClass = window.AudioContext || window.webkitAudioContext;
          if (!AudioContextClass) throw new Error('Web Audio is unavailable');
          if (!audioContext || audioContext.state === 'closed') audioContext = new AudioContextClass();
          if (audioContext.state === 'suspended') await audioContext.resume();

          const synth = new ABCJS.synth.CreateSynth();
          const result = await synth.init({
            audioContext,
            visualObj,
            options: {
              soundFontUrl: options.soundFontUrl,
              chordsOff: options.chordsOff,
              voicesOff: options.voicesOff,
            },
          });
          if (result.error.length) throw new Error(result.error.join(', '));
          await synth.prime();
          if (destroyed) return;

          blobUrl = synth.download();
          audio.src = blobUrl;
          audio.load();
          downloadButton.disabled = false;
        })();
      }

      try {
        await loadPromise;
      } catch (cause) {
        loadPromise = null;
        error.textContent = 'Audio could not be loaded. Reload the page to retry.';
        error.hidden = false;
        console.warn('ABCJS playback failed:', cause);
        throw cause;
      } finally {
        if (!destroyed) setLoading(false);
      }
    }

    const player = {
      host,
      audio,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        if (activePlayer === player) activePlayer = null;
        if (host._abcjsPlayer === player) host._abcjsPlayer = null;
        players.delete(player);
      },
    };

    playButton.addEventListener('click', async () => {
      if (!audio.paused) {
        audio.pause();
        return;
      }
      try {
        await prepareAudio();
        if (destroyed) return;
        if (activePlayer && activePlayer !== player) activePlayer.audio.pause();
        await audio.play();
        activePlayer = player;
      } catch (cause) {
        if (blobUrl) {
          error.textContent = 'Playback was blocked. Press play again.';
          error.hidden = false;
        }
      }
    });

    restartButton.addEventListener('click', () => {
      if (blobUrl) audio.currentTime = 0;
    });
    progress.addEventListener('input', () => {
      if (Number.isFinite(audio.duration) && audio.duration) {
        audio.currentTime = audio.duration * Number(progress.value) / 1000;
      }
    });
    volume.addEventListener('input', () => {
      audio.volume = Number(volume.value);
      audio.muted = false;
      muteButton.querySelector('i').className = 'fa-solid fa-volume-high';
      muteButton.title = 'Mute';
      muteButton.setAttribute('aria-label', 'Mute');
    });
    muteButton.addEventListener('click', () => {
      audio.muted = !audio.muted;
      const label = audio.muted ? 'Unmute' : 'Mute';
      muteButton.title = label;
      muteButton.setAttribute('aria-label', label);
      muteButton.querySelector('i').className = `fa-solid fa-volume-${audio.muted ? 'xmark' : 'high'}`;
    });
    rate.addEventListener('change', () => { audio.playbackRate = Number(rate.value); });
    loopButton.addEventListener('click', () => {
      audio.loop = !audio.loop;
      loopButton.setAttribute('aria-pressed', String(audio.loop));
    });
    downloadButton.addEventListener('click', () => {
      if (!blobUrl) return;
      const title = (visualObj.metaText && visualObj.metaText.title || 'score')
        .replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 80) || 'score';
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = `${title}.wav`;
      link.click();
    });

    audio.addEventListener('loadedmetadata', updateTime);
    audio.addEventListener('durationchange', updateTime);
    audio.addEventListener('timeupdate', updateTime);
    audio.addEventListener('play', updatePlayButton);
    audio.addEventListener('pause', updatePlayButton);
    audio.addEventListener('ended', updatePlayButton);
    audio.addEventListener('error', () => {
      if (!destroyed) {
        error.textContent = 'The generated audio could not be played.';
        error.hidden = false;
      }
    });

    host._abcjsPlayer = player;
    players.add(player);
    observeRemovedPlayers();
    return player;
  }

  window.AbcjsPlayer = { mount };
})();

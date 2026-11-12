// Voice mode (Pro): hold Option+Cmd to talk and let go to send (Ctrl+Option+V toggles the same;
// main turns both into voice-hold events). While you talk, a live waveform sits beside the blue
// cursor. The microphone stays open for 30 s after a question so the next first word isn't
// clipped. Silence and noise make speech models invent sentences, so the recording is checked
// for speech here first and only the speech, trimmed and normalised, goes out as a 16 kHz mono
// WAV. The answer is spoken and appears word by word beside the cursor.
(function () {
  'use strict';

  const ui = window.GOATUI;
  const goat = window.goat || {};
  if (!ui) return;

  const RATE = 16000;
  const MAX_MS = 25000; // Gemma takes about 30 s of audio
  const WARM_MS = 30000; // keep the mic open this long after a question
  const MIN_HOLD_MS = 350; // shorter holds are Option+Cmd shortcuts, not questions
  const MIN_SPEECH_MS = 300;
  const BARS = 9;

  // ---------- speech detection (pure, also used by tests) ----------
  // 20 ms frames; the noise floor is the 10th-percentile frame energy (the pauses between words
  // when speech fills the whole hold; the 20th percentile then sat on quiet speech and rejected
  // it). Voiced frames are 3x the floor and above an absolute minimum, so steady noise never
  // passes. Returns the voiced span with 160 ms margins, or null.
  function findSpeech(samples, rate = RATE) {
    const frame = Math.round(rate / 50);
    const energy = [];
    for (let i = 0; i + frame <= samples.length; i += frame) {
      let sum = 0;
      for (let j = i; j < i + frame; j += 1) sum += samples[j] * samples[j];
      energy.push(Math.sqrt(sum / frame));
    }
    if (!energy.length) return null;
    const sorted = [...energy].sort((a, b) => a - b);
    const floor = Math.max(sorted[Math.floor(sorted.length * 0.1)], 1e-4);
    const gate = Math.max(floor * 3, 0.004);
    const voiced = energy.map((e) => e > gate);
    const first = voiced.indexOf(true);
    if (first < 0) return null;
    const last = voiced.lastIndexOf(true);
    const count = voiced.filter(Boolean).length;
    return {
      voicedMs: count * 20,
      start: Math.max(0, first - 8) * frame,
      end: Math.min(energy.length, last + 9) * frame,
    };
  }

  // Peak to about -1 dBFS, at most 10x louder (so faint noise isn't blown up).
  function normalise(samples) {
    let peak = 0;
    for (const x of samples) peak = Math.max(peak, Math.abs(x));
    const gain = peak > 0 ? Math.min(10, 0.89 / peak) : 1;
    return samples.map((x) => x * gain);
  }

  function encodeWav(samples, rate = RATE) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const text = (offset, s) => {
      for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    text(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i += 1) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  // Raw samples at the mic's rate -> 16 kHz mono.
  async function toMono16k(samples, rate) {
    if (!samples.length) return new Float32Array(0);
    const source = new AudioBuffer({ length: samples.length, numberOfChannels: 1, sampleRate: rate });
    source.copyToChannel(samples, 0);
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil((samples.length / rate) * RATE)), RATE);
    const node = offline.createBufferSource();
    node.buffer = source;
    node.connect(offline.destination);
    node.start();
    return (await offline.startRendering()).getChannelData(0);
  }

  // ---------- the HUD beside the cursor ----------
  const hud = ui.el('div', 'voice-hud');
  const bars = Array.from({ length: BARS }, () => {
    const bar = ui.el('i', 'bar');
    hud.append(bar);
    return bar;
  });
  const dots = ui.el('span', 'dots');
  dots.append(ui.el('i'), ui.el('i'), ui.el('i'));
  hud.append(dots);
  ui.cursorEl.append(hud);

  // listening | working | speaking | '' (hidden)
  function setState(name) {
    ui.cursorEl.dataset.voice = name || '';
    ui.cursorEl.classList.toggle('listening', name === 'listening');
  }

  // ---------- microphone ----------
  let mic = null; // { stream, ctx, analyser, chunks, capturing, idleTimer }

  async function openMic() {
    if (mic) {
      clearTimeout(mic.idleTimer);
      return mic;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext();
    await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    const processor = ctx.createScriptProcessor(2048, 1, 1);
    const m = { stream, ctx, analyser, processor, chunks: [], capturing: false, idleTimer: null };
    processor.onaudioprocess = (e) => {
      if (m.capturing) m.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(analyser);
    source.connect(processor);
    processor.connect(ctx.destination); // a script processor only runs when connected; it outputs silence
    mic = m;
    return m;
  }

  function closeMicLater() {
    if (!mic) return;
    clearTimeout(mic.idleTimer);
    const m = mic;
    m.idleTimer = setTimeout(() => {
      if (mic !== m) return;
      mic = null;
      m.stream.getTracks().forEach((t) => t.stop());
      m.ctx.close();
    }, WARM_MS);
  }

  // ---------- a voice turn ----------
  let wantDown = false;
  let turn = null; // { started, timer }
  let busy = false;
  let raf = 0;
  let voiceGuide = null; // a guide started by a spoken question reads its steps aloud
  let lastTurn = null; // what the last recording held (for troubleshooting)

  function waveform(m) {
    const data = new Uint8Array(m.analyser.fftSize);
    const levels = new Array(BARS).fill(0);
    const loop = () => {
      if (!turn) return;
      m.analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += ((v - 128) / 128) ** 2;
      levels.push(Math.min(1, Math.sqrt(sum / data.length) * 7));
      levels.shift();
      bars.forEach((bar, i) => {
        // the newest level in the middle, older ones spreading out
        const l = levels[BARS - 1 - Math.abs(i - Math.floor(BARS / 2)) * 2] ?? 0;
        bar.style.transform = `scaleY(${(0.18 + l * 0.82).toFixed(3)})`;
      });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function proNeeded() {
    ui.showBubble({ kind: 'error', text: 'Voice mode is part of GOAT Pro. Upgrade in the wallet to use it.', follow: true });
    if (window.GOATWallet) window.GOATWallet.open();
  }

  function quietNote(text) {
    ui.showBubble({ kind: 'info', text, follow: true, ms: 3500 });
  }

  async function start() {
    if (busy || turn) return;
    ui.stopSpeaking(); // talking over GOAT stops it
    const wallet = window.GOATWallet ? await window.GOATWallet.refresh() : null;
    if (wallet && !wallet.pro) {
      proNeeded();
      return;
    }
    let m;
    try {
      m = await openMic();
    } catch {
      ui.showBubble({ kind: 'error', text: "GOAT can't use the microphone. Allow it in System Settings > Privacy & Security > Microphone.", follow: true });
      return;
    }
    if (!wantDown) return; // let go while the mic was opening: too short to be a question
    m.chunks = [];
    m.capturing = true;
    turn = { started: performance.now(), timer: setTimeout(() => stop(), MAX_MS) };
    ui.hideBubble();
    setState('listening');
    waveform(m);
    ui.emit('voice:start', {});
  }

  async function stop() {
    if (!turn) return;
    const t = turn;
    turn = null;
    clearTimeout(t.timer);
    cancelAnimationFrame(raf);
    const m = mic;
    m.capturing = false;
    const recorded = m.chunks;
    m.chunks = [];
    closeMicLater();
    if (performance.now() - t.started < MIN_HOLD_MS) {
      setState('');
      return;
    }
    busy = true;
    setState('working');
    try {
      const all = new Float32Array(recorded.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of recorded) {
        all.set(c, offset);
        offset += c.length;
      }
      const mono = await toMono16k(all, m.ctx.sampleRate);
      const speech = findSpeech(mono);
      let peak = 0;
      for (const x of mono) peak = Math.max(peak, Math.abs(x));
      lastTurn = { chunks: recorded.length, rate: m.ctx.sampleRate, seconds: mono.length / RATE, peak: Number(peak.toFixed(4)), voicedMs: speech ? speech.voicedMs : 0 };
      if (!speech || speech.voicedMs < MIN_SPEECH_MS) {
        setState('');
        quietNote(`I didn't hear a question. Hold ${ui.hotkey('talk')} and talk.`);
        return;
      }
      const clip = normalise(mono.subarray(speech.start, speech.end));
      const heard = goat.transcribe ? await goat.transcribe(toBase64(encodeWav(clip))) : { error: 'unavailable', message: 'Voice mode is not available.' };
      if (!heard || heard.error) {
        setState('');
        if (heard && heard.error === 'pro_required') proNeeded();
        else if (heard && heard.error === 'no_speech') quietNote(heard.message);
        else ui.showBubble({ kind: 'error', text: (heard && heard.message) || 'Transcription failed.', follow: true });
        return;
      }
      ui.emit('voice:transcript', { transcript: heard.transcript });
      ui.setVoice(true);
      await ui.ask(heard.transcript, { voice: true });
    } finally {
      ui.setVoice(false);
      busy = false;
      // The dots stay while GOAT's voice is on its way: speak:start or speak:end takes over.
      if (!turn && ui.cursorEl.dataset.voice === 'working' && !ui.speechPending()) setState('');
    }
  }

  ui.onEvent('voice-hold', (msg) => {
    wantDown = Boolean(msg.down);
    if (wantDown) start();
    else stop();
  });
  ui.onEvent('voice-error', (msg) => ui.showBubble({ kind: 'error', text: msg.message, follow: true }));

  // While GOAT talks, the bars sway; a spoken question's guide reads its steps aloud.
  ui.onEvent('speak:start', () => {
    if (!turn) setState('speaking');
  });
  ui.onEvent('speak:end', () => {
    const now = ui.cursorEl.dataset.voice;
    if (now === 'speaking' || (now === 'working' && !busy && !turn)) setState('');
  });
  ui.onEvent('reply', (reply) => {
    voiceGuide = ui.state().voice && reply && reply.source === 'guide' && reply.guide ? reply.guide.id : null;
  });
  ui.onEvent('guide:step', (step) => {
    if (step.id === voiceGuide) ui.speak(step.index === 0 ? `${step.intro} ${step.say}` : step.say, { force: true });
  });
  ui.onEvent('guide:end', (end) => {
    if (end.id === voiceGuide) voiceGuide = null;
  });

  window.GOATVoice = { findSpeech, normalise, encodeWav, toBase64, toMono16k, listening: () => Boolean(turn), lastTurn: () => lastTurn };
})();

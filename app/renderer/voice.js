// Voice mode (Pro): Ctrl+Option+V starts listening and pressing it again sends (global shortcuts
// can't see key-up), with an auto-stop at 25 s. MediaRecorder -> decodeAudioData -> 16 kHz mono
// (OfflineAudioContext) -> PCM16 WAV -> base64 -> main -> server -> transcript -> ask. The answer
// is spoken with speechSynthesis.
(function () {
  'use strict';

  const ui = window.GOATUI;
  const goat = window.goat || {};
  if (!ui) return;

  const RATE = 16000;
  const MAX_MS = 25000;
  const pill = ui.el('span', 'voice-pill', '');
  ui.cursorEl.append(pill);
  let rec = null; // { recorder, stream, chunks, timer }
  let busy = false;

  function setListening(on) {
    ui.cursorEl.classList.toggle('listening', on);
    pill.textContent = on ? `Listening… ${ui.hotkey('voice')} to send` : '';
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

  async function toMono16k(audioBuffer) {
    const frames = Math.max(1, Math.ceil(audioBuffer.duration * RATE));
    const offline = new OfflineAudioContext(1, frames, RATE); // one channel: sources are down-mixed
    const source = offline.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
  }

  function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }

  async function blobToWavBase64(blob) {
    const ctx = new AudioContext();
    try {
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      return toBase64(encodeWav(await toMono16k(decoded)));
    } finally {
      ctx.close();
    }
  }

  function proNeeded() {
    ui.showBubble({ kind: 'error', text: 'Voice mode is part of GOAT Pro. Upgrade in the wallet to use it.', follow: true });
    if (window.GOATWallet) window.GOATWallet.open();
  }

  async function start() {
    if (busy) return;
    const wallet = window.GOATWallet ? await window.GOATWallet.refresh() : null;
    if (wallet && !wallet.pro) {
      proNeeded();
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch {
      ui.showBubble({ kind: 'error', text: "GOAT can't use the microphone. Allow it in System Settings > Privacy & Security > Microphone.", follow: true });
      return;
    }
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size) chunks.push(e.data);
    };
    recorder.start(250);
    rec = { recorder, stream, chunks, timer: setTimeout(() => stop(), MAX_MS) };
    ui.hideBubble();
    setListening(true);
    ui.emit('voice:start', {});
  }

  function stop() {
    if (!rec) return;
    const r = rec;
    rec = null;
    clearTimeout(r.timer);
    setListening(false);
    r.recorder.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      finish(new Blob(r.chunks, { type: r.recorder.mimeType || 'audio/webm' }));
    };
    r.recorder.stop();
  }

  async function finish(blob) {
    busy = true;
    ui.setThinking(true);
    try {
      let audio;
      try {
        audio = await blobToWavBase64(blob);
      } catch {
        ui.setThinking(false);
        ui.showBubble({ kind: 'error', text: "I couldn't read that recording. Try again.", follow: true });
        return;
      }
      const t = goat.transcribe ? await goat.transcribe(audio) : { error: 'unavailable', message: 'Voice mode is not available.' };
      if (!t || t.error) {
        ui.setThinking(false);
        if (t && t.error === 'pro_required') proNeeded();
        else ui.showBubble({ kind: 'error', text: (t && t.message) || 'Transcription failed.', follow: true });
        return;
      }
      ui.emit('voice:transcript', { transcript: t.transcript });
      ui.toast(`You asked: “${t.transcript}”`, { ms: 4000 });
      ui.setVoice(true); // speak this answer
      await ui.ask(t.transcript);
    } finally {
      ui.setVoice(false);
      busy = false;
    }
  }

  ui.onEvent('voice-toggle', () => (rec ? stop() : start()));
  ui.onEvent('voice-error', (msg) => ui.showBubble({ kind: 'error', text: msg.message, follow: true }));

  window.GOATVoice = { encodeWav, toMono16k, toBase64, listening: () => Boolean(rec) };
})();

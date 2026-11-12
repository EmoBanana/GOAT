'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useRef, useState } from 'react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

// The mock app is drawn at 960 x 540 and scaled to fit; positions are in those units.
const W = 960;
const H = 540;
const MAX_SCALE = 1.25;
// GOAT's cursor is a kopitiam cup (app/renderer/cursor-art.js): a 28-unit box that points with
// the left edge of its rim, at (3, 9).
const CUP = {
  body: 'M14 21 L17.5 40 Q18.5 44 23 44 L37 44 Q41.5 44 42.5 40 L46 21 Z',
  handle: 'M44.6 25.5 C53 24.5 54.5 36.5 43.4 35.8',
  band: 'M15.9 25.4 L44.1 25.4 L43.55 28.6 L16.45 28.6 Z',
  steam: 'M25 15.5 c-2.6 -2.6 2.6 -4.6 0 -7.6 M33.5 15.5 c-2.6 -2.6 2.6 -4.6 0 -7.6',
};
const INTRO = 'Let’s log an issue in Forma Build, following the site QA procedure.';
// The sample Forma guide, kept as a test fixture: server/test/fixtures/guides/forma-log-issue.json.
const STEPS = [
  { target: 'issues', say: 'Open Issues from the left menu.' },
  { target: 'create', say: 'Click Create issue at the top right.' },
  { target: 'type', say: 'Pick the type. Site defects go under Quality, Defect.' },
  { target: 'title', say: 'Title it location first, then the defect.' },
  { target: 'assignee', say: 'Assign it to the package manager for that area.' },
  { target: 'photo', say: 'Attach at least one photo.' },
  { target: 'submit', say: 'Hit Create. Done.' },
];
// Where GOAT waits between runs: beside the user's pointer.
const REST = { x: 560, y: 470 };
const ROWS = [
  ['#212', 'L2 slab, bay B/3: exposed rebar', 'Open'],
  ['#209', 'Pier 14 plinth: honeycombing', 'In review'],
  ['#204', 'Grid C/4 column: cover under 40 mm', 'Open'],
  ['#198', 'Stair core S2: formwork offset', 'Closed'],
  ['#191', 'L1 parapet: missing cast-in anchors', 'Closed'],
];

// A quadratic arc that lifts above both ends, like the app's flights.
function arc(a, b, t) {
  const lift = Math.max(60, Math.hypot(b.x - a.x, b.y - a.y) * 0.3);
  const c = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - lift };
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

export function CursorDemo() {
  const frame = useRef(null);
  const stage = useRef(null);
  const intro = useRef(null);
  const text = useRef(null);
  const stepLine = useRef(null);
  const counter = useRef(null);
  const sayLine = useRef(null);
  const timeline = useRef(null);
  const userPaused = useRef(false);
  const scaleRef = useRef(1);
  const [scale, setScale] = useState(1);
  const [playing, setPlaying] = useState(true);

  useGSAP(
    () => {
      const fit = () => {
        const s = Math.min(MAX_SCALE, frame.current.clientWidth / W);
        scaleRef.current = s;
        setScale(s);
      };
      fit();
      const observer = new ResizeObserver(fit);
      observer.observe(frame.current);

      const q = gsap.utils.selector(stage);
      const [cursor] = q('.demo-cursor');
      const [ring] = q('.demo-ring');
      const [bubble] = q('.demo-bubble');
      const pointOf = (name) => {
        const r = q(`[data-target="${name}"]`)[0].getBoundingClientRect();
        const s = stage.current.getBoundingClientRect();
        return { x: (r.left + r.width / 2 - s.left) / scaleRef.current, y: (r.top + r.height / 2 - s.top) / scaleRef.current };
      };
      const label = (value) => {
        counter.current.textContent = value;
      };
      // Land on step i: the ring centred on the button, the bubble beside it, kept inside the window.
      const show = (i, at) => {
        intro.current.textContent = i === 0 ? INTRO : '';
        text.current.textContent = STEPS[i].say;
        stepLine.current.textContent = `Step ${i + 1} of ${STEPS.length}`;
        sayLine.current.textContent = STEPS[i].say; // readable under the demo on a phone
        label(`Step ${i + 1} of ${STEPS.length}`);
        stage.current.dataset.step = String(i + 1);
        const x = at.x + 26 + bubble.offsetWidth > W - 12 ? at.x - bubble.offsetWidth - 26 : at.x + 26;
        const y = at.y + 30 + bubble.offsetHeight > H - 12 ? at.y - bubble.offsetHeight - 30 : at.y + 30;
        gsap.set(ring, { x: at.x, y: at.y, autoAlpha: 1 });
        gsap.fromTo(bubble, { x, y: y + 6, autoAlpha: 0 }, { y, autoAlpha: 1, duration: 0.2, ease: 'power2.out', overwrite: true });
      };
      const hide = () => {
        gsap.set(ring, { autoAlpha: 0 });
        gsap.to(bubble, { autoAlpha: 0, duration: 0.12, overwrite: true });
      };

      const mm = gsap.matchMedia();
      mm.add({ motion: '(prefers-reduced-motion: no-preference)', still: '(prefers-reduced-motion: reduce)' }, (ctx) => {
        if (ctx.conditions.still) {
          // One still frame: the cursor on step 2.
          const at = pointOf('create');
          gsap.set(cursor, { x: at.x, y: at.y, autoAlpha: 1 });
          show(1, at);
          return undefined;
        }
        const pos = { ...REST };
        const proxy = { t: 0 };
        gsap.set(cursor, { x: pos.x, y: pos.y, autoAlpha: 1 });
        label('Ready');
        const flight = (leg, duration) => ({
          t: 1,
          duration,
          ease: 'power2.inOut',
          immediateRender: false,
          onUpdate: () => {
            const p = arc(leg.from, leg.to, proxy.t);
            pos.x = p.x;
            pos.y = p.y;
            gsap.set(cursor, { x: p.x, y: p.y });
          },
        });
        const tl = gsap.timeline({ repeat: -1, repeatDelay: 0.6, paused: true });
        STEPS.forEach((step, i) => {
          const leg = { from: null, to: null };
          tl.add(() => {
            leg.from = { ...pos };
            leg.to = pointOf(step.target);
            hide();
          });
          tl.fromTo(proxy, { t: 0 }, flight(leg, 0.8));
          tl.add(() => show(i, leg.to));
          tl.to({}, { duration: i === STEPS.length - 1 ? 2.4 : 1.9 });
        });
        const home = { from: null, to: REST };
        tl.add(() => {
          home.from = { ...pos };
          hide();
          label('Guide finished');
          delete stage.current.dataset.step;
        });
        tl.fromTo(proxy, { t: 0 }, flight(home, 0.9));
        timeline.current = tl;
        ScrollTrigger.create({
          trigger: frame.current,
          start: 'top 85%',
          end: 'bottom 15%',
          onToggle: (self) => (self.isActive && !userPaused.current ? tl.play() : tl.pause()),
        });
        return () => {
          timeline.current = null;
        };
      });
      return () => {
        observer.disconnect();
        mm.revert();
      };
    },
    { scope: frame },
  );

  function toggle() {
    const tl = timeline.current;
    if (!tl) return;
    userPaused.current = !tl.paused();
    if (userPaused.current) tl.pause();
    else tl.play();
    setPlaying(!userPaused.current);
  }

  return (
    <figure className="demo">
      <div className="demo-frame" ref={frame} style={{ height: Math.round(H * scale) }}>
        <div className="demo-stage" ref={stage} style={{ transform: `scale(${scale})` }} aria-hidden="true">
          <div className="app-titlebar">
            <span className="app-dots">
              <i />
              <i />
              <i />
            </span>
            <span>Forma Build · Sample: Alpha Viaduct</span>
          </div>
          <div className="app-body">
            <nav className="app-nav">
              <span>Home</span>
              <span data-target="issues">Issues</span>
              <span>Forms</span>
              <span>Photos</span>
              <span>Schedules</span>
              <span>Reports</span>
            </nav>
            <div className="app-main">
              <div className="app-head">
                <span className="app-h">Issues</span>
                <span className="app-btn" data-target="create">
                  Create issue
                </span>
              </div>
              <div className="app-table">
                <div className="app-row app-row-head">
                  <span>ID</span>
                  <span>Title</span>
                  <span>Status</span>
                </div>
                {ROWS.map(([id, title, status]) => (
                  <div className="app-row" key={id}>
                    <span className="app-id">{id}</span>
                    <span>{title}</span>
                    <span className={`app-status app-status-${status.split(' ')[0].toLowerCase()}`}>{status}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="app-form">
              <span className="app-h app-h-sm">New issue</span>
              <span className="app-label">
                Type
                <span className="app-field" data-target="type">
                  Quality · Defect
                </span>
              </span>
              <span className="app-label">
                Title
                <span className="app-field" data-target="title">
                  Grid C/4 column: honeycombing
                </span>
              </span>
              <span className="app-label">
                Assigned to
                <span className="app-field" data-target="assignee">
                  Package manager, zone C
                </span>
              </span>
              <span className="app-label">
                Attachments
                <span className="app-field app-drop" data-target="photo">
                  + Add photo
                </span>
              </span>
              <span className="app-btn app-btn-primary" data-target="submit">
                Create
              </span>
            </div>
          </div>
          <div className="demo-ring">
            <i />
          </div>
          <div className="demo-bubble">
            <p className="demo-bubble-intro" ref={intro} />
            <p className="demo-bubble-text" ref={text} />
            <p className="demo-bubble-step" ref={stepLine} />
          </div>
          <div className="demo-cursor">
            <svg viewBox="0 0 28 28" width="28" height="28">
              <g transform="translate(3 9) scale(0.58) translate(-14 -21)" strokeLinejoin="round" strokeLinecap="round">
                <g transform="translate(2.4 2.4)" fill="#0a0a0a" stroke="#0a0a0a" strokeWidth="2.4">
                  <path d={CUP.body} />
                  <path d={CUP.handle} fill="none" strokeWidth="5" />
                </g>
                <path d={CUP.handle} fill="none" stroke="#0a0a0a" strokeWidth="6.6" />
                <path d={CUP.handle} fill="none" stroke="#ffffff" strokeWidth="2.6" />
                <path d={CUP.body} fill="#ffffff" />
                <path d={CUP.band} fill="#1f7a4d" />
                <path d={CUP.body} fill="none" stroke="#0a0a0a" strokeWidth="2.4" />
                <ellipse cx="30" cy="21" rx="16" ry="3.6" fill="#ffffff" stroke="#0a0a0a" strokeWidth="2.4" />
                <ellipse cx="30" cy="21.3" rx="13.1" ry="2.3" fill="#6b3f1d" />
                <path d={CUP.steam} fill="none" stroke="#ffffff" strokeWidth="4.6" />
                <path d={CUP.steam} fill="none" stroke="#0a0a0a" strokeWidth="2.4" />
              </g>
            </svg>
          </div>
        </div>
      </div>
      <figcaption className="demo-bar">
        <button type="button" className="btn btn-sm btn-plain" onClick={toggle} aria-pressed={!playing}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <span className="demo-counter" ref={counter} aria-hidden="true" />
        <span className="demo-say" ref={sayLine} aria-hidden="true" />
        <span className="demo-caption">Log a site issue in Forma Build, in seven steps.</span>
      </figcaption>
      <ol className="sr-only" aria-label="The guide in the demo">
        {STEPS.map((step) => (
          <li key={step.target}>{step.say}</li>
        ))}
      </ol>
    </figure>
  );
}

'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useRef } from 'react';

gsap.registerPlugin(useGSAP, ScrollTrigger);

// One paid assist, as the four HTTP messages x402 adds up to. The arrows draw in order while the
// figure is on screen; with reduced motion they're simply all there.
export function PaymentFlow({ price, server }) {
  const root = useRef(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const steps = gsap.utils.toArray('.flow-step', root.current);
        const arrows = steps.map((s) => s.querySelector('.flow-arrow'));
        const words = steps.map((s) => s.querySelector('.flow-words'));
        const tl = gsap.timeline({ repeat: -1, repeatDelay: 1.2, paused: true });
        tl.set(arrows, { scaleX: 0 }).set(words, { autoAlpha: 0 });
        steps.forEach((_, i) => {
          tl.to(words[i], { autoAlpha: 1, duration: 0.25 })
            .to(arrows[i], { scaleX: 1, duration: 0.55, ease: 'power2.inOut' }, '<')
            .to({}, { duration: 0.75 });
        });
        tl.to({}, { duration: 1.6 });
        ScrollTrigger.create({
          trigger: root.current,
          start: 'top 85%',
          end: 'bottom 15%',
          onToggle: (self) => (self.isActive ? tl.play() : tl.pause()),
        });
      });
      return () => mm.revert();
    },
    { scope: root },
  );

  return (
    <figure className="panel flow" ref={root} aria-labelledby="flow-title">
      <figcaption id="flow-title" className="panel-title">
        One paid assist
      </figcaption>
      <div className="flow-head">
        <span>
          <b>The app</b>
          <small>The cursor, the keys, and your wallet’s key</small>
        </span>
        <span>
          <b>GOAT server</b>
          <small>Guides, AI and your SOPs, at {server}</small>
        </span>
      </div>
      <ol className="flow-steps">
        <li className="flow-step flow-out">
          <span className="flow-words">
            <code>POST /api/assist</code>
            <span>Your question</span>
          </span>
          <span className="flow-arrow" aria-hidden="true" />
        </li>
        <li className="flow-step flow-back">
          <span className="flow-words">
            <code>402 Payment Required</code>
            <span>{price}, payable to GOAT</span>
          </span>
          <span className="flow-arrow" aria-hidden="true" />
        </li>
        <li className="flow-step flow-out">
          <span className="flow-words">
            <code>POST /api/assist</code>
            <span>Again, with a payment the app signed</span>
          </span>
          <span className="flow-arrow" aria-hidden="true" />
        </li>
        <li className="flow-step flow-back">
          <span className="flow-words">
            <code>200 OK</code>
            <span>The answer, and a receipt</span>
          </span>
          <span className="flow-arrow" aria-hidden="true" />
        </li>
      </ol>
      <p className="flow-foot">Settled on-chain in digital dollars. You never copy a wallet address or pay network fees.</p>
    </figure>
  );
}

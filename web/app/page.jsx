import { CupLogo } from '@/components/CupLogo';
import { CursorDemo } from '@/components/CursorDemo';
import { DownloadButton, DownloadButtons } from '@/components/DownloadButton';
import { Keys } from '@/components/Keys';
import { PaymentFlow } from '@/components/PaymentFlow';
import { ServerNotice } from '@/components/ServerNotice';
import data from '@/data/downloads.json';
import { hostOf, isLocal, mb, rm, usd } from '@/lib/format';

function SectionHead({ id, label, title }) {
  return (
    <header className="section-head">
      <p className="section-label">{label}</p>
      <h2 id={id}>{title}</h2>
    </header>
  );
}

function PlatformCard({ build, name, beta, steps, note }) {
  return (
    <article className="panel platform" aria-labelledby={`dl-${name}`}>
      <h3 id={`dl-${name}`}>
        {name}
        {beta && <span className="tag">Beta</span>}
      </h3>
      <div className="platform-get">
        <DownloadButton build={build} />
        {build && (
          <p className="meta">
            {data.version} · {build.arch} · {mb(build.bytes)}
          </p>
        )}
      </div>
      <ol className="install">
        {steps.map((step, i) => (
          <li key={i}>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {note && <p className="platform-note">{note}</p>}
      {build && (
        <p className="sha">
          SHA-256 <code>{build.sha256}</code>
        </p>
      )}
    </article>
  );
}

export default function Page() {
  const { builds, pricing: p, version } = data;
  const mac = builds.find((b) => b.platform === 'darwin');
  const win = builds.find((b) => b.platform === 'win32');
  const serverUrl = (mac || win)?.serverUrl || 'http://127.0.0.1:8402';
  const server = hostOf(serverUrl);
  const welcome = p.payments === 'x402-local' && p.welcomeMyr > 0;

  return (
    <>
      <header className="bar">
        <div className="wrap bar-inner">
          <a className="wordmark" href="#top" aria-label="GOAT, back to the top">
            <CupLogo className="logo" />
            GOAT
          </a>
          <nav className="nav" aria-label="Page">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a className="btn btn-sm" href="#download">
              Download
            </a>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="wrap">
            <div className="hero-top">
              <h1 id="hero-title">
                A second cursor that shows you <mark>where to click.</mark>
              </h1>
              <div className="hero-side">
                <p className="lede">
                  GOAT sits beside your pointer in any app. Ask how to do something and it flies to each button in turn, telling you what to do there, step by step.
                </p>
                <DownloadButtons builds={builds} />
                <ServerNotice serverUrl={serverUrl} />
                <p className="meta">Free for Mac and Windows · {rm(p.assistMyr)} per assist</p>
              </div>
            </div>
            <CursorDemo />
          </div>
        </section>

        <section id="how" className="section" aria-labelledby="how-title">
          <div className="wrap">
            <SectionHead id="how-title" label="How it works" title="Ask in plain words. GOAT points, or it answers." />
            <ol className="steps">
              <li>
                <span className="step-n">1</span>
                <h3>Ask</h3>
                <p>
                  Press <Keys keys="Ctrl Option G" /> in any app and type your question. On Windows it’s <Keys keys="Ctrl Alt G" />.
                </p>
              </li>
              <li>
                <span className="step-n">2</span>
                <h3>GOAT shows you</h3>
                <p>The cursor guides you to each button in turn and tells you what to do there.</p>
              </li>
              <li>
                <span className="step-n">3</span>
                <h3>Pay per assist</h3>
                <p>{rm(p.assistMyr)} comes off your balance. Nothing per month, and an answer that fails costs nothing.</p>
              </li>
            </ol>
            <div className="features">
              <article className="feature">
                <h3>Guides</h3>
                <p>The cursor finds each button on your screen, at any resolution or window size, and takes you through the task one step at a time.</p>
              </article>
              <article className="feature">
                <h3>Answers</h3>
                <p>Ask anything and the AI answers from your SOPs. Drag over part of a drawing to ask about just that area.</p>
              </article>
              <article className="feature">
                <h3>Timesheet</h3>
                <p>
                  GOAT notes the project from window titles, so <code>ALP-GAM-…-0001.rvt</code> counts toward ALPHA. You approve the hours.
                </p>
              </article>
              <article className="feature">
                <h3>
                  Voice <span className="tag">Pro</span>
                </h3>
                <p>Ask out loud and hear the answer. GOAT also sees the area around your pointer.</p>
              </article>
            </div>
          </div>
        </section>

        <section id="pricing" className="section" aria-labelledby="pricing-title">
          <div className="wrap">
            <SectionHead id="pricing-title" label="Pricing and privacy" title="Pay per assist. GOAT only looks when you ask." />
            <div className="bento">
              <div className="panel panel-price">
                <p className="price-tag">
                  <span className="price">{rm(p.assistMyr)}</span>
                  <span className="price-unit">per assist · {usd(p.assistUsd)}</span>
                </p>
                <dl className="facts">
                  <div>
                    <dt>Download</dt>
                    <dd>Free</dd>
                  </div>
                  <div>
                    <dt>GOAT Pro</dt>
                    <dd>
                      {rm(p.proMyr)} for {p.proDays} days: voice, and no charge per assist
                    </dd>
                  </div>
                  <div>
                    <dt>Top-ups</dt>
                    <dd>In ringgit.{welcome ? ` New wallets start with ${rm(p.welcomeMyr)}.` : ''}</dd>
                  </div>
                  <div>
                    <dt>Failed answers</dt>
                    <dd>Never charged</dd>
                  </div>
                </dl>
              </div>
              <PaymentFlow price={usd(p.assistUsd)} server={server} />
              <div className="panel panel-privacy">
                <h3 className="panel-title">What GOAT leaves alone</h3>
                <dl className="privacy">
                  <div>
                    <dt>Keystrokes</dt>
                    <dd>Never read. Push-to-talk only checks whether its keys are held.</dd>
                  </div>
                  <div>
                    <dt>Your screen</dt>
                    <dd>Read only when you ask, and never stored.</dd>
                  </div>
                  <div>
                    <dt>Window titles</dt>
                    <dd>Only from apps your company allows, while tracking is on.</dd>
                  </div>
                  <div>
                    <dt>Chats</dt>
                    <dd>Questions and answers only, kept on your GOAT server so you can pick them up again. Delete them any time.</dd>
                  </div>
                  <div>
                    <dt>The AI</dt>
                    <dd>{isLocal(serverUrl) ? 'Runs on this Mac, not in someone else’s cloud.' : 'Runs on your GOAT server, not in someone else’s cloud.'}</dd>
                  </div>
                </dl>
              </div>
            </div>
          </div>
        </section>

        <section id="download" className="section" aria-labelledby="download-title">
          <div className="wrap">
            <SectionHead id="download-title" label="Download" title="Get GOAT for Mac or Windows." />
            <ServerNotice serverUrl={serverUrl} className="server-note-section" />
            <div className="platforms">
              <PlatformCard
                build={mac}
                name="macOS"
                steps={[
                  'Open the zip, drag GOAT into Applications and open it.',
                  'macOS can’t check this build for malware yet, because it isn’t notarised. In System Settings › Privacy & Security, click Open Anyway.',
                  'Sign in, or choose Continue offline.',
                  'Allow Accessibility, Microphone and Screen Recording when macOS asks.',
                ]}
                note="Needs a Mac with Apple silicon."
              />
              <PlatformCard
                build={win}
                name="Windows"
                beta
                steps={[
                  'Right-click the zip, choose Extract All, then open GOAT.exe in the GOAT folder.',
                  'If SmartScreen stops it, click More info, then Run anyway. This build isn’t signed yet.',
                  'Sign in, or choose Continue offline.',
                  'GOAT sits in the system tray, next to the clock.',
                ]}
                note="Needs 64-bit Windows 10 or 11. Reading whole documents and finding buttons live on screen are Mac-only for now."
              />
            </div>
            <div className="panel keys-panel">
              <h3 className="panel-title">Hotkeys</h3>
              <table className="hotkeys">
                <thead>
                  <tr>
                    <th scope="col">Mac</th>
                    <th scope="col">Windows</th>
                    <th scope="col">What it does</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <Keys keys="Ctrl Option G" />
                    </td>
                    <td>
                      <Keys keys="Ctrl Alt G" />
                    </td>
                    <td>Ask. Hold and drag to ask about part of the screen.</td>
                  </tr>
                  <tr>
                    <td>
                      Hold <Keys keys="Option Cmd" />
                    </td>
                    <td>
                      <Keys keys="Ctrl Alt V" />
                    </td>
                    <td>Ask out loud (Pro). On Windows, press again to send.</td>
                  </tr>
                  <tr>
                    <td>
                      <Keys keys="Ctrl Option T" />
                    </td>
                    <td>
                      <Keys keys="Ctrl Alt T" />
                    </td>
                    <td>Start tracking. Press again for today’s timesheet.</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="req">
              Both builds need a GOAT server they can reach. These connect to <code>{server}</code>.
            </p>
          </div>
        </section>
      </main>

      <footer className="foot">
        <div className="wrap foot-inner">
          <span>GOAT {version}</span>
          <span>Built at an internal hackathon, November 2026</span>
        </div>
      </footer>
    </>
  );
}

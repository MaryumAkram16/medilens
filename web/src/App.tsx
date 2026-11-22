import { useEffect, useState } from 'react';
import { ComplaintForm } from './components/ComplaintForm';
import { StaffDesk } from './components/StaffDesk';
import { StatusLookup } from './components/StatusLookup';
import { VoiceCall } from './components/VoiceCall';

export type Route = 'home' | 'complaints' | 'status' | 'staff';

export function routeFromHash(hash: string): Route {
  const r = hash.replace(/^#\/?/, '').split(/[?/]/)[0];
  return r === 'complaints' || r === 'status' || r === 'staff' ? r : 'home';
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => routeFromHash(window.location.hash));
  useEffect(() => {
    const on = () => {
      setRoute(routeFromHash(window.location.hash));
      window.scrollTo?.(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

const NAV: { route: Route; label: string }[] = [
  { route: 'home', label: 'Voice Agent' },
  { route: 'complaints', label: 'Complaints' },
  { route: 'status', label: 'Track' },
  { route: 'staff', label: 'Staff Desk' },
];

export function App() {
  const route = useRoute();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    setMenu(false);
  }, [route]);

  return (
    <>
      <header className="site-header">
        <a className="brand" href="#/">
          <span className="logo" aria-hidden="true">
            ✚
          </span>
          <span>
            Medi<b>Lens</b>
          </span>
        </a>
        <button className="menu-toggle" aria-expanded={menu} aria-controls="nav" onClick={() => setMenu(!menu)}>
          <span className="sr-only">Menu</span>☰
        </button>
        <nav id="nav" className={menu ? 'open' : ''} aria-label="Main">
          {NAV.map((n) => (
            <a key={n.route} href={n.route === 'home' ? '#/' : `#/${n.route}`} aria-current={route === n.route ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
      </header>

      <main id="main">
        {route === 'home' && <Home />}
        {route === 'complaints' && (
          <Page title={<>Complaint <em>Center</em></>} lead="Tell us what went wrong, in writing or by voice. Our AI reads it, sets the priority and sends it straight to the right department.">
            <div className="card narrow">
              <ComplaintForm />
            </div>
          </Page>
        )}
        {route === 'status' && (
          <Page title={<>Track your <em>complaint</em></>} lead="Use the code you were given and the email or phone number you filed with.">
            <div className="card narrow">
              <StatusLookup />
            </div>
          </Page>
        )}
        {route === 'staff' && (
          <section className="page wide">
            <StaffDesk />
          </section>
        )}
      </main>

      {route !== 'complaints' && route !== 'staff' && (
        <a className="fab" href="#/complaints">
          <span aria-hidden="true">💬</span> Complaint Center
        </a>
      )}

      <footer className="site-footer">
        <p>
          <strong>MediLens is a portfolio demo.</strong> It does not give medical advice. In an emergency in Pakistan call <a href="tel:1122">1122</a>.
        </p>
        <p className="muted small">Voice agent by Retell · triage and transcription by Gemini · built by Maryum Akram</p>
      </footer>
    </>
  );
}

function Page({ title, lead, children }: { title: React.ReactNode; lead: string; children: React.ReactNode }) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="lead">{lead}</p>
      {children}
    </section>
  );
}

function Home() {
  return (
    <>
      <section className="hero">
        <div className="hero-text">
          <p className="eyebrow">MediLens Voice Agent</p>
          <h1>
            Book with your <em>Voice</em>
          </h1>
          <p className="lead">Talk to our AI receptionist in English or Urdu. It finds a doctor, books, moves or cancels your appointment, and takes complaints, all in one call.</p>
          <ul className="examples" aria-label="Things you can say">
            <li>“I need a cardiologist on Thursday morning.”</li>
            <li>“Move my appointment to next week.”</li>
            <li>“I want to complain about my bill.”</li>
          </ul>
        </div>
        <div className="hero-call card">
          <VoiceCall />
        </div>
      </section>

      <section className="features">
        <Feature icon="🎙️" title="Real phone-style calls">
          Speak naturally from your browser. The agent checks live availability and confirms bookings by email.
        </Feature>
        <Feature icon="🧭" title="AI triage">
          Complaints are read by Gemini, given a priority and routed to one of nine departments. Unsure cases go to a person.
        </Feature>
        <Feature icon="🚨" title="Safety first">
          Emergencies are always flagged, whatever the AI says, and the patient is told to call 1122.
        </Feature>
        <Feature icon="⏱️" title="No complaint forgotten">
          Every department has a response time. Overdue complaints escalate automatically.
        </Feature>
      </section>
    </>
  );
}

function Feature({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <div className="feature">
      <span className="feature-icon" aria-hidden="true">
        {icon}
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

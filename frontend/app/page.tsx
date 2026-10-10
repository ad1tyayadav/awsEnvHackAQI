'use client';

// Clean Air Day-Planner dashboard (single page, PRD section 6).
// API base URL comes from NEXT_PUBLIC_API_URL baked in at build time.
// Features: add-school form, list with tier badges, status panel with AQI +
// bilingual advisory toggle, 24h trend list, "Simulate severe day" button,
// loading/empty/error states, accessibility (color + label), disclaimer.
import { useCallback, useEffect, useState } from 'react';
import * as demo from '../lib/demoMode';
import { AlertEmail } from '../lib/alertInbox';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const DEMO_MODE = !API_URL || API_URL.includes('localhost') === false && API_URL === '';
const USING_DEMO = !API_URL.trim(); // fall back to in-browser demo when no API is baked in

interface School {
  schoolId: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  contactEmails?: string[];
  lastAlertTier?: string | null;
}

interface Status {
  school: School;
  latest: null | {
    schoolId: string; ts: string; pm25: number; aqi: number;
    category: string; tier: string; source: string; stationName?: string;
  };
  advisory: null | { en: string; hi: string };
  history: {
    schoolId: string; ts: string; pm25: number; aqi: number;
    category: string; tier: string; source: string;
  }[];
}

const TIER_STYLES: Record<string, { badge: string; label: string }> = {
  GREEN: { badge: 'bg-green-100 text-green-800 border-green-600', label: 'Good / Satisfactory' },
  YELLOW: { badge: 'bg-yellow-100 text-yellow-900 border-yellow-600', label: 'Moderate' },
  ORANGE: { badge: 'bg-orange-100 text-orange-900 border-orange-600', label: 'Poor — alert sent' },
  RED: { badge: 'bg-red-100 text-red-900 border-red-600', label: 'Very Poor / Severe — alert sent' },
};

function TierBadge({ tier, size = 'md' }: { tier: string; size?: 'md' | 'lg' }) {
  const style = TIER_STYLES[tier] ?? {
    badge: 'bg-slate-100 text-slate-700 border-slate-400',
    label: 'No data yet',
  };
  return (
    <span
      className={`${style.badge} border-2 inline-flex items-center gap-1 rounded-full font-semibold ${
        size === 'lg' ? 'px-4 py-1.5 text-base' : 'px-2.5 py-0.5 text-xs'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block rounded-full ${
          tier === 'RED' ? 'bg-red-600' : tier === 'ORANGE' ? 'bg-orange-600' : tier === 'YELLOW' ? 'bg-yellow-500' : tier === 'GREEN' ? 'bg-green-600' : 'bg-slate-400'
        } w-2 h-2`}
      />
      {tier || '—'} · {style.label}
    </span>
  );
}

export default function Home() {
  const [schools, setSchools] = useState<School[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [lang, setLang] = useState<'en' | 'hi'>('en');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [formMsg, setFormMsg] = useState<string | null>(null);
  const [simAlert, setSimAlert] = useState<{ subject: string; body: string } | null>(null);

  const loadSchools = useCallback(async () => {
    if (USING_DEMO) {
      setSchools(demo.getSchools());
      setError(null);
      return;
    }
    try {
      const res = await fetch(`${API_URL}/schools`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as School[];
      setSchools(data);
      setError(null);
      if (data.length > 0 && !selectedId) setSelectedId(data[0].schoolId);
    } catch (e) {
      setError(`Could not reach the API at ${API_URL} — check it is deployed. (${(e as Error).message})`);
      setSchools([]);
    }
  }, [selectedId, USING_DEMO]);

  useEffect(() => {
    void loadSchools();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadStatus = useCallback(async (id: string) => {
    if (USING_DEMO) {
      setStatus(demo.getStatus(id) as unknown as Status);
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${API_URL}/schools/${id}/status`);
      if (res.status === 404) { setStatus(null); setError(null); }
      else if (!res.ok) throw new Error(`HTTP ${res.status}`);
      else { setStatus((await res.json()) as Status); setError(null); }
    } catch (e) {
      setError(`Could not load school status. (${(e as Error).message})`);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadStatus(selectedId);
  }, [selectedId, loadStatus]);

  async function simulateSevere() {
    if (!selectedId) return;
    setSimulating(true);
    try {
      if (USING_DEMO) {
        const { status: s, alertFired } = demo.simulate(selectedId, { tier: 'RED' });
        if (s && alertFired) {
          const email = demo.formatAlertEmail(s.school, 'RED', s.latest!.aqi);
          setSimAlert({ subject: email.subject, body: email.body });
        }
        if (s) setStatus(s as unknown as Status);
        await loadSchools();
        return;
      }
      const res = await fetch(`${API_URL}/schools/${selectedId}/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: 'RED' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // refresh status (a RED reading + alert email were just generated)
      await loadStatus(selectedId);
    } catch (e) {
      setError(`Simulate failed. (${(e as Error).message})`);
    } finally {
      setSimulating(false);
    }
  }

  const latest = status?.latest ?? null;
  const advisory = status?.advisory ?? null;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-8">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Clean Air Day-Planner for Schools</h1>
            <p className="mt-1 text-slate-600">
              When the air turns bad, every school gets a clear, bilingual action plan before the first bell, automatically.
            </p>
          </div>
          {USING_DEMO && (
            <span className="rounded-full bg-blue-100 text-blue-800 border border-blue-300 px-3 py-1 text-xs font-medium">
              Demo mode · same rules, in-browser
            </span>
          )}
        </div>
      </header>

      {error && (
        <div role="alert" className="mb-6 rounded-lg border border-red-300 bg-red-50 p-4 text-red-800">
          {error}
        </div>
      )}

      <section className="grid gap-8 md:grid-cols-2">
        {/* left: add school + list */}
        <div className="space-y-8">
          <AddSchoolForm
            usingDemo={USING_DEMO}
            onCreated={async (created, args) => {
              if (USING_DEMO && args) {
                const s = demo.createSchool({
                  name: created.name,
                  city: args.city,
                  lat: args.lat,
                  lng: args.lng,
                  contactEmails: args.emails,
                });
                setFormMsg(`✅ "${created.name}" added (demo).`);
                await loadSchools();
                setSelectedId(s.schoolId);
              } else {
                const res = await fetch(`${API_URL}/schools`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(args),
                });
                if (!res.ok) {
                  const errBody = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
                  setFormMsg(`Could not add school: ${errBody.error ?? `HTTP ${res.status}`}`);
                } else {
                  setFormMsg(`✅ "${created.name}" added. Each contact email will receive an SNS confirmation link — alerts only arrive after they confirm.`);
                  await loadSchools();
                  if (created.schoolId) setSelectedId(created.schoolId);
                }
              }
            }}
            onError={setFormMsg}
          />

          <section>
            <h2 className="mb-2 text-lg font-semibold">Schools</h2>
            {schools === null ? (
              <p className="text-slate-500 animate-pulse">Loading schools…</p>
            ) : schools.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 p-4 text-slate-500">
                No schools yet. Add your first school with the form above.
              </p>
            ) : (
              <ul className="space-y-2">
                {schools.map((s) => (
                  <li key={s.schoolId}>
                    <button
                      onClick={() => setSelectedId(s.schoolId)}
                      className={`flex w-full items-center justify-between rounded-lg border p-3 text-left transition ${
                        selectedId === s.schoolId ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <span>
                        <span className="font-medium">{s.name}</span>
                        <span className="ml-2 text-sm text-slate-500">{s.city}</span>
                      </span>
                      <TierBadge tier={s.lastAlertTier ?? ''} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* right: status panel */}
        <div>
          <h2 className="mb-2 text-lg font-semibold">Today&apos;s status</h2>
          {!selectedId ? (
            <p className="text-slate-500">Select a school to see its status.</p>
          ) : busy ? (
            <p className="animate-pulse text-slate-500">Loading status…</p>
          ) : !latest ? (
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="text-slate-600">
                No reading yet. The Lambda runs every 30 minutes, or press &quot;Simulate severe day&quot; to demo instantly.
              </p>
              <button
                onClick={simulateSevere}
                disabled={simulating}
                className="mt-3 w-full rounded-lg bg-red-600 px-4 py-3 font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              >
                {simulating ? 'Simulating…' : 'Simulate severe day'}
              </button>
            </div>
          ) : (
            <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <div>
                  <div className="text-5xl font-bold" aria-label={`AQI ${latest.aqi}`}>{latest.aqi}</div>
                  <div className="text-sm text-slate-500">AQI</div>
                </div>
                <div>
                  <TierBadge tier={latest.tier} size="lg" />
                  <div className="mt-1 text-sm text-slate-600">{latest.category}</div>
                </div>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-slate-500">Source</dt>
                <dd>{latest.source === 'simulated' ? 'Simulated (demo)' : `Live · ${latest.stationName ?? 'OpenAQ'}`}</dd>
                <dt className="text-slate-500">PM2.5</dt>
                <dd>{latest.pm25} µg/m³</dd>
                <dt className="text-slate-500">Updated</dt>
                <dd>{new Date(latest.ts).toLocaleString()}</dd>
              </dl>

              <button
                onClick={simulateSevere}
                disabled={simulating}
                className="w-full rounded-lg bg-red-600 px-4 py-3 font-semibold text-white hover:bg-red-700 disabled:opacity-60"
              >
                {simulating ? 'Simulating…' : 'Simulate severe day'}
              </button>

              {advisory && (
                <div className="rounded-lg bg-slate-50 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="font-semibold">Action plan</h3>
                    <div className="flex rounded-full border border-slate-300 p-0.5 text-sm" role="group" aria-label="Advisory language">
                      <button
                        onClick={() => setLang('en')}
                        aria-pressed={lang === 'en'}
                        className={`rounded-full px-3 py-0.5 ${lang === 'en' ? 'bg-blue-600 text-white' : 'text-slate-700'}`}
                      >
                        English
                      </button>
                      <button
                        onClick={() => setLang('hi')}
                        aria-pressed={lang === 'hi'}
                        className={`rounded-full px-3 py-0.5 ${lang === 'hi' ? 'bg-blue-600 text-white' : 'text-slate-700'}`}
                      >
                        हिंदी
                      </button>
                    </div>
                  </div>
                  <p className="text-slate-800">{lang === 'en' ? advisory.en : advisory.hi}</p>
                </div>
              )}

              {status && status.history.length > 0 && (
                <details open>
                  <summary className="cursor-pointer font-semibold">Last {Math.min(24, status.history.length)} readings</summary>
                  <ul className="mt-2 space-y-1 text-sm">
                    {status.history.slice(0, 24).map((r) => (
                      <li key={r.ts} className="flex items-center gap-2">
                        <span className="w-40 shrink-0 text-slate-500">{new Date(r.ts).toLocaleString()}</span>
                        <span className="w-2 h-4" style={{ backgroundColor: r.tier === 'RED' ? '#dc2626' : r.tier === 'ORANGE' ? '#ea580c' : r.tier === 'YELLOW' ? '#ca8a04' : '#16a34a' }} aria-hidden />
                        <span className="w-14 font-medium">AQI {r.aqi}</span>
                        <TierBadge tier={r.tier} />
                        <span className="text-slate-400">{r.source}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      </section>
      {formMsg && <p className="mt-6 rounded-lg bg-blue-50 p-3 text-sm text-blue-800">{formMsg}</p>}

      {simAlert && (
        <AlertEmail
          school="your school"
          tier={latest?.tier ?? 'RED'}
          aqi={latest?.aqi ?? 329}
          subject={simAlert.subject}
          body={simAlert.body}
          onClose={() => setSimAlert(null)}
        />
      )}

      <footer className="mt-12 border-t border-slate-200 pt-4 text-xs text-slate-500">
        <p>
          Advisories are guidance based on hourly PM2.5 estimates and do not replace official orders from local
          authorities. CPCB AQI normally uses 24-hour averages; this prototype uses the latest hourly reading as a
          real-time estimate.
        </p>
      </footer>
    </main>
  );
}

function AddSchoolForm({ usingDemo, onCreated, onError }: {
  usingDemo: boolean;
  onCreated: (school: { name: string; schoolId?: string }, ctx?: { city: string; lat: number; lng: number; emails: string[] }) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [emails, setEmails] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    const latNum = Number(lat), lngNum = Number(lng);
    const emailList = emails.split(',').map((s) => s.trim()).filter(Boolean);
    if (!name.trim()) return setLocalError('School name is required.');
    if (!city.trim()) return setLocalError('City is required.');
    if (!Number.isFinite(latNum) || latNum < -90 || latNum > 90) return setLocalError('Latitude must be between -90 and 90 (Delhi ≈ 28.6).');
    if (!Number.isFinite(lngNum) || lngNum < -180 || lngNum > 180) return setLocalError('Longitude must be between -180 and 180 (Delhi ≈ 77.2).');
    if (emailList.length === 0) return setLocalError('At least one contact email is required.');
    if (emailList.length > 5) return setLocalError('At most 5 contact emails.');
    if (emailList.some((e2) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e2))) return setLocalError('One or more emails are not valid.');

    setSubmitting(true);
    try {
      if (usingDemo) {
        await onCreated({ name: name.trim() }, { city: city.trim(), lat: latNum, lng: lngNum, emails: emailList });
        setName(''); setCity(''); setLat(''); setLng(''); setEmails('');
        return;
      }
      const res = await fetch(`${API_URL}/schools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), city: city.trim(), lat: latNum, lng: lngNum, contactEmails: emailList }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string };
        onError(`Could not add school: ${errBody.error ?? `HTTP ${res.status}`}`);
      } else {
        await onCreated({ name: name.trim(), schoolId: ((await res.json()) as School).schoolId });
        setName(''); setCity(''); setLat(''); setLng(''); setEmails('');
      }
    } catch (e) {
      onError(`Network error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">Add a school</h2>
      <form onSubmit={submit} className="space-y-3">
        <input className="w-full rounded-md border border-slate-300 px-3 py-2" placeholder="School name (e.g. DL Public School)" value={name} onChange={(e) => setName(e.target.value)} required />
        <input className="w-full rounded-md border border-slate-300 px-3 py-2" placeholder="City (e.g. Delhi)" value={city} onChange={(e) => setCity(e.target.value)} required />
        <div className="grid grid-cols-2 gap-3">
          <input className="rounded-md border border-slate-300 px-3 py-2" placeholder="Latitude (28.6)" value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" required />
          <input className="rounded-md border border-slate-300 px-3 py-2" placeholder="Longitude (77.2)" value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" required />
        </div>
        <input className="w-full rounded-md border border-slate-300 px-3 py-2" placeholder="Contact emails, comma-separated (max 5)" value={emails} onChange={(e) => setEmails(e.target.value)} required />
        {localError && <p role="alert" className="text-sm text-red-700">{localError}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded-md bg-blue-600 px-4 py-2.5 font-medium text-white hover:bg-blue-700 disabled:opacity-60"
        >
          {submitting ? 'Adding…' : 'Add school'}
        </button>
        <p className="text-xs text-slate-500">
          Each contact email gets an AWS SNS confirmation link — alerts only start after they click it.
        </p>
      </form>
    </section>
  );
}

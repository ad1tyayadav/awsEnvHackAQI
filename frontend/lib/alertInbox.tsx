'use client';

// Alert Inbox panel - a visual stand-in for the email that SNS would deliver.
// In real (deployed) mode your actual Gmail/Outlook tab shows the arriving
// email; in demo mode this panel renders the same content so judges can
// see exactly what would reach the principal's inbox.
export function AlertEmail({ school, tier, aqi, subject, body, onClose }: {
  school: string;
  tier: string;
  aqi: number;
  subject: string;
  body: string;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-label="Simulated alert email">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm text-slate-600">
          <span className="font-mono">air-alerts@cleanair.demo</span>
          <button onClick={onClose} className="rounded-full px-2 text-lg leading-none hover:bg-slate-200" aria-label="Close">
            ×
          </button>
        </div>
        <div className="p-4">
          <h3 className="text-base font-semibold mb-1">{subject}</h3>
          <p className="text-xs text-slate-500 mb-3">
            From: Clean Air Day-Planner &lt;alerts@cleanair-planner.demo&gt; · To: you@example.com
          </p>
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-800">{body}</pre>
          <div className="mt-3 rounded-md bg-amber-50 border border-amber-200 p-2 text-xs text-amber-800">
            💡 Demo preview — in the deployed backend, AWS SNS delivers this exact email to every
            confirmed subscriber for this school.
          </div>
        </div>
      </div>
    </div>
  );
}

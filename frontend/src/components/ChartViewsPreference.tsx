import { useState } from 'react';
import { useChartViews } from '../providers/ChartViewsProvider';

export function ChartViewsPreference() {
  const preferences = useChartViews();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  return <div className="profile-pref-row">
    <div className="profile-pref-text"><strong>Chart views</strong><span>Your visual choices are saved to your account.</span>{error && <span className="nm-chart-save-error" role="alert">{error}</span>}{message && <span role="status">{message}</span>}{preferences?.error && <span role="alert">{preferences.error}</span>}</div>
    <div className="profile-pref-control"><button type="button" className="nm-btn nm-btn--sm" disabled={busy || !preferences || preferences.loading || !!preferences.error} onClick={async () => {
      if (!preferences) return;
      setBusy(true); setError(''); setMessage('');
      try { await preferences.reset(); setMessage('All charts restored to their default views.'); }
      catch { setError('Could not reset chart views. Try again.'); }
      finally { setBusy(false); }
    }}>{busy ? 'Resetting…' : 'Reset all chart views'}</button></div>
  </div>;
}

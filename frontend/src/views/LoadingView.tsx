import { SkeletonLine } from "../components/Skeleton";

export function LoadingView() {
  return (
    <section className="auth-surface">
      <div className="auth-card">
        <h1>NetMap</h1>
        <div className="auth-loading-skeleton" role="status" aria-label="Loading secure workspace">
          <SkeletonLine width="72%" height={12} />
          <SkeletonLine width="48%" height={12} />
        </div>
      </div>
    </section>
  );
}

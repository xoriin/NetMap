export function StatusCssErrors({ id, className, errors }: { id: string; className?: string; errors: string[] }) {
  return (
    <div id={id} className={`nm-alert nm-alert--error${className ? ` ${className}` : ""}`} role="alert">
      <div>
        <strong>The CSS was not saved.</strong>
        {errors.map((error) => <div key={error}>{error}</div>)}
      </div>
    </div>
  );
}

import React from 'react';

export default function Panel({ title, action, children, className = '' }) {
  return (
    <section className={`panel flex flex-col ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-base-700">
          <h2 className="panel-title">{title}</h2>
          {action}
        </div>
      )}
      <div className="min-h-0 flex-1 p-4">{children}</div>
    </section>
  );
}

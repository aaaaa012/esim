export function OrderRowsLoading() {
  return (
    <div
      className="order-list-loading"
      role="status"
      aria-label="Loading orders"
    >
      <p>Loading orders…</p>
      <div aria-hidden="true">
        {[0, 1, 2].map((row) => (
          <div className="esim-row" key={row}>
            <div className="skel order-skeleton-icon" />
            <div className="esim-main">
              <div className="skel order-skeleton-title" />
              <div className="skel order-skeleton-meta" />
            </div>
            <div className="skel order-skeleton-status" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function OrderLoading() {
  return (
    <main className="account-page">
      <div className="shell">
        <div className="account-head">
          <div>
            <h1>My orders</h1>
            <p>Your purchases and top-ups.</p>
          </div>
        </div>
        <OrderRowsLoading />
      </div>
    </main>
  );
}

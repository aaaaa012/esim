import "./checkout.css";

export default function Loading() {
  return (
    <main className="checkout-page">
      <div className="checkout-shell">
        <div className="checkout-heading">
          <div
            className="skel"
            style={{ width: 200, height: 24, marginBottom: 8 }}
          />
          <div className="skel" style={{ width: 280, height: 14 }} />
        </div>
        <div className="checkout-progress">
          <div
            className="skel"
            style={{ width: "25%", height: 4, borderRadius: 999 }}
          />
        </div>
        <div className="checkout-layout">
          <section className="checkout-card">
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div
                className="skel"
                style={{ width: "100%", height: 44, borderRadius: 8 }}
              />
              <div
                className="skel"
                style={{ width: "100%", height: 44, borderRadius: 8 }}
              />
              <div
                className="skel"
                style={{ width: "100%", height: 44, borderRadius: 8 }}
              />
              <div
                className="skel"
                style={{ width: "60%", height: 44, borderRadius: 8 }}
              />
            </div>
          </section>
          <aside className="order-summary">
            <div
              className="skel"
              style={{
                width: "100%",
                height: 60,
                borderRadius: 10,
                marginBottom: 14,
              }}
            />
            <div
              className="skel"
              style={{ width: "80%", height: 14, marginBottom: 8 }}
            />
            <div
              className="skel"
              style={{ width: "60%", height: 14, marginBottom: 14 }}
            />
            <div
              className="skel"
              style={{ width: "100%", height: 36, borderRadius: 8 }}
            />
          </aside>
        </div>
      </div>
    </main>
  );
}

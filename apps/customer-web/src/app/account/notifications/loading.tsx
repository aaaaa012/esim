import "./notifications.css";

export default function Loading() {
  return (
    <div className="customer-notification-list" style={{ opacity: 0.6 }}>
      {[1, 2, 3].map((i) => (
        <article key={i}>
          <div
            className="skel"
            style={{ width: 22, height: 22, borderRadius: 6, flexShrink: 0 }}
          />
          <div style={{ flex: 1 }}>
            <div
              className="skel"
              style={{ width: 200, height: 14, marginBottom: 6 }}
            />
            <div className="skel" style={{ width: "60%", height: 12 }} />
          </div>
        </article>
      ))}
    </div>
  );
}

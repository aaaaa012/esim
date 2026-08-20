import "./esims.css";

export default function Loading() {
  return (
    <div className="esim-dashboard" style={{ opacity: 0.6 }}>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 22,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 20,
        }}
      >
        <div>
          <div
            className="skel"
            style={{ width: 160, height: 20, marginBottom: 8 }}
          />
          <div className="skel" style={{ width: 100, height: 14 }} />
        </div>
        <div
          className="skel"
          style={{ width: 80, height: 36, borderRadius: 8 }}
        />
      </div>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 22,
        }}
      >
        <div
          className="skel"
          style={{ width: 120, height: 16, marginBottom: 14 }}
        />
        <div style={{ display: "flex", gap: 14 }}>
          <div
            className="skel"
            style={{ flex: 1, height: 64, borderRadius: 10 }}
          />
          <div
            className="skel"
            style={{ flex: 1, height: 64, borderRadius: 10 }}
          />
        </div>
      </div>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-lg)",
          padding: 22,
        }}
      >
        <div
          className="skel"
          style={{ width: 140, height: 16, marginBottom: 14 }}
        />
        <div
          className="skel"
          style={{ width: "100%", height: 40, borderRadius: 8 }}
        />
      </div>
    </div>
  );
}

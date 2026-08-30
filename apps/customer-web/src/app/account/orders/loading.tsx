import "../esims/esims.css";

export default function Loading() {
  return (
    <div style={{ opacity: 0.6 }}>
      {[1, 2, 3].map((i) => (
        <div key={i} className="esim-row" style={{ marginBottom: 12 }}>
          <div
            className="skel"
            style={{ width: 50, height: 50, borderRadius: 15 }}
          />
          <div className="esim-main">
            <div
              className="skel"
              style={{ width: 180, height: 16, marginBottom: 6 }}
            />
            <div className="skel" style={{ width: 120, height: 12 }} />
          </div>
          <div
            className="skel"
            style={{ width: 70, height: 28, borderRadius: 8 }}
          />
        </div>
      ))}
    </div>
  );
}

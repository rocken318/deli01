import KioskClient from "./KioskClient";

export const dynamic = "force-dynamic";

export default function AttendanceKioskPage() {
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ color: "#1C2321", marginBottom: 4 }}>出退勤 キオスク</h1>
      <p style={{ color: "#5b625f", fontSize: 13, marginBottom: 16 }}>
        事務所の端末に表示し、セラピスト本人のスマホでスキャンしてもらいます。QRは自動更新されます。
      </p>
      <KioskClient />
    </main>
  );
}

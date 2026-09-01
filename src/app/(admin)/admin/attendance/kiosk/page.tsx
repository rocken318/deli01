import { getDevSession } from "@/lib/cms/dev-session";
import { toActor } from "@/lib/auth/session";
import { can } from "@/domain/auth";
import KioskClient from "./KioskClient";

export const dynamic = "force-dynamic";

export default async function AttendanceKioskPage() {
  const session = await getDevSession();
  if (!session || !can(toActor(session), "manage_cms")) {
    return <main style={{ padding: 24 }}>権限がありません。</main>;
  }

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

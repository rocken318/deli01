import { redirect } from "next/navigation";

/** /admin → /admin/fields へリダイレクト */
export default function AdminIndexPage() {
  redirect("/admin/fields");
}

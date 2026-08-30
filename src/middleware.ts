import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * /admin/* と /mypage/* の入口ゲート（UX 用）。防御の本線はページ/アクションの
 * getSession -> withUser -> RLS。ここは cookie の有無で未認証を /login に飛ばすだけ。
 *
 * ゲートしない条件（スタブ運用・ローカル・ビルドを壊さない）:
 *   - ADMIN_DEV_SESSION=1（ローカル/CI のスタブ認証）
 *   - Supabase 未設定（URL / anon key）
 */
export async function middleware(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (process.env.ADMIN_DEV_SESSION === "1" || !url || !anon) {
    return NextResponse.next();
  }

  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          req.cookies.set(name, value);
        }
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of cookiesToSet) {
          res.cookies.set(name, value, options);
        }
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const redirectUrl = new URL("/login", req.url);
    redirectUrl.searchParams.set("next", req.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return res;
}

export const config = {
  matcher: ["/admin/:path*", "/mypage/:path*"],
};

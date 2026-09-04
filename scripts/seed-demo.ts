/**
 * デモ/検証用データ投入（冪等・追加専用）。core seed(scripts/seed.ts)は変更せず、
 * その上に「ダミーセラピスト追加 + 当月の出勤 + 過去の接客(done予約) + 報酬(payout_lines)」を足す。
 * 管理側 overview・接客履歴・稼ぎ表示が実データで動くことを確認するため。
 *
 * 使い方: DATABASE_URL=<接続> pnpm tsx scripts/seed-demo.ts
 * 何度流しても重複しない（固定UUID + on conflict do nothing）。
 */
import postgres from "postgres";
import { shiftInstants, addDaysISO, localDateISO } from "../src/domain/availability/shift";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL が未設定です");
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });

// 追加する4人（画像 005-008.jpg は public/therapists に配置済み）
const NEW_THERAPISTS = [
  { slug: "sakura", name: "さくら", catch: "指先まで丁寧に、癒しのひとときを", img: "005", mediaSuffix: "0005", displayOrder: 50, rank: "レギュラー" },
  { slug: "yuna", name: "ゆな", catch: "笑顔と真心で、日頃の疲れをリセット", img: "006", mediaSuffix: "0006", displayOrder: 60, rank: "プレミア" },
  { slug: "mei", name: "めい", catch: "深いリンパで芯からほぐします", img: "007", mediaSuffix: "0007", displayOrder: 70, rank: "レギュラー" },
  { slug: "rin", name: "りん", catch: "ゆったりオイルで極上のリラックス", img: "008", mediaSuffix: "0008", displayOrder: 80, rank: "新人" },
] as const;

async function main() {
  const today = localDateISO(new Date());
  const month = today.slice(0, 7);

  // ---- 1) 4人を追加（media / therapists / entity_records(公開) / rank）----
  for (const t of NEW_THERAPISTS) {
    const mediaId = `bbbbbbbb-0001-4000-8000-00000000${t.mediaSuffix}`;
    await sql`
      insert into media (id, url, alt, tags, consent_flag, consent_date, face_visibility, is_placeholder)
      values (${mediaId}::uuid, ${`/therapists/${t.img}.jpg`},
              ${`セラピスト「${t.name}」ダミー写真`}, ${["therapist", "demo"] as unknown as string[]}::text[],
              true, now(), 'face'::face_visibility, false)
      on conflict (id) do update set url = excluded.url, face_visibility = excluded.face_visibility,
        consent_flag = excluded.consent_flag, alt = excluded.alt
    `;
    await sql`
      insert into therapists (slug, status, display_order)
      values (${t.slug}, 'active', ${t.displayOrder})
      on conflict (slug) do update set status = 'active', display_order = excluded.display_order
    `;
    // ランク（payout_rate 解決に使う therapists.rank_id 列）
    await sql`
      update therapists set rank_id = (select id from therapist_ranks where name = ${t.rank})
      where slug = ${t.slug}
    `;
    const draft = { name: t.name, catch_copy: t.catch, photo: [mediaId] };
    await sql`
      insert into entity_records (entity, slug, draft, published, published_at)
      values ('therapist', ${t.slug}, ${sql.json(draft)}, ${sql.json(draft)}, now())
      on conflict (entity, slug) do update set draft = excluded.draft, published = excluded.published, published_at = now()
    `;
    console.log(`therapist upsert: ${t.slug} (${t.name})`);
  }

  // ---- 対象セラピスト（既存の公開2人 + 新規4人）----
  const targets = await sql<{ id: string; slug: string; rank_id: string | null }[]>`
    select id, slug, rank_id from therapists
    where slug in ('aoi', 'ren', 'sakura', 'yuna', 'mei', 'rin')
    order by display_order
  `;

  // 有効なコース率（個別 > ランク > 既定）を解決するためのレート表を先読み。
  // デモ会計を「実エンジンと同じ率」で作るため（40% 固定の手打ちをやめる）。
  const courseRates = await sql<
    { therapist_id: string | null; rank_id: string | null; value: number }[]
  >`
    select therapist_id, rank_id, value
    from payout_rates
    where target_type = 'course' and calc_type = 'rate' and effective_to is null
  `;
  const resolveCourseRate = (t: { id: string; rank_id: string | null }): number => {
    const individual = courseRates.find((r) => r.therapist_id === t.id);
    if (individual) return individual.value;
    const rank = t.rank_id ? courseRates.find((r) => r.rank_id === t.rank_id) : undefined;
    if (rank) return rank.value;
    const def = courseRates.find((r) => r.therapist_id === null && r.rank_id === null);
    return def?.value ?? 50;
  };

  // 参照データ
  const areaRows = await sql<{ id: string }[]>`select id from areas where name = '国分町' limit 1`;
  const areaId = areaRows[0]!.id;
  // シフトの対応エリア（shift_areas）に付ける全アクティブエリア。
  // ★これが無いと空き枠エンジンが枠を1件も返さず「調整中」になる（earliest.ts）。
  const activeAreas = await sql<{ id: string }[]>`select id from areas where is_active = true`;
  const activeAreaIds = activeAreas.map((a) => a.id);
  // 待機拠点（base）。★base が null だと base→目的地の距離が取れず枠が出ない
  //   （reservation-data.buildTravelDataSource）。事務所拠点を出発/帰着に使う。
  const baseRows = await sql<{ id: string }[]>`
    select id from bases where kind = 'office' order by created_at limit 1
  `;
  const baseId = baseRows[0]?.id ?? null;
  const courses = await sql<{ id: string; price: number; duration_min: number; nomination_fee_default: number }[]>`
    select id, price, duration_min, nomination_fee_default from courses order by duration_min limit 3
  `;
  const custs = await sql<{ id: string; address_id: string }[]>`
    select c.id, a.id as address_id
    from customers c join addresses a on a.customer_id = c.id and a.kind = 'home'
    order by c.created_at limit 3
  `;
  if (courses.length === 0 || custs.length === 0) {
    throw new Error("courses / customers が無い。先に core seed を流すこと");
  }

  // ---- 2) 当月の出勤（各対象・平日 + 一部週末）----
  const [y, m] = month.split("-").map(Number);
  const daysInMonth = new Date(y!, m!, 0).getDate();
  let shiftCount = 0;
  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti]!;
    for (let day = 1; day <= daysInMonth; day++) {
      const dateISO = `${month}-${String(day).padStart(2, "0")}`;
      const dow = new Date(y!, m! - 1, day).getDay();
      // セラピストごとに休みの曜日をずらす（0=日,6=土は半分休み）
      const off = dow === (ti % 7) || (dow === 0 && ti % 2 === 0);
      if (off) continue;
      const startH = 11 + (ti % 3); // 11/12/13時開始
      const start = `${String(startH).padStart(2, "0")}:00`;
      const end = `${String(startH + 9).padStart(2, "0")}:00`;
      const { startAt, endAt } = shiftInstants(dateISO, start, end);
      const shiftRows = await sql<{ id: string }[]>`
        insert into shifts (therapist_id, work_date, start_at, end_at, max_bookings, base_start_id, base_end_id)
        values (${t.id}::uuid, ${dateISO}::date, ${startAt}, ${endAt}, 4, ${baseId}::uuid, ${baseId}::uuid)
        on conflict (therapist_id, work_date) do update set
          start_at = excluded.start_at, end_at = excluded.end_at, max_bookings = excluded.max_bookings,
          base_start_id = excluded.base_start_id, base_end_id = excluded.base_end_id
        returning id
      `;
      const shiftId = shiftRows[0]!.id;
      // 対応エリア（全アクティブエリア）を全置換。これが無いと枠が出ない＝調整中。
      await sql`delete from shift_areas where shift_id = ${shiftId}::uuid`;
      for (const aid of activeAreaIds) {
        await sql`
          insert into shift_areas (shift_id, area_id)
          values (${shiftId}::uuid, ${aid}::uuid)
          on conflict do nothing
        `;
      }
      shiftCount++;
    }
  }
  console.log(`shifts upsert: ~${shiftCount}`);

  // ---- 2.5) 当日＋翌日の確定予約（配車ボード・予約管理・当日状況の動作確認用）----
  const RECEPTION = "aaaaaaaa-0000-4000-8000-000000000003"; // 受付 app_user
  let confirmedCount = 0;
  for (let ti = 0; ti < Math.min(targets.length, 3); ti++) {
    const t = targets[ti]!;
    for (const dayOffset of [0, 1]) {
      const dateISO = addDaysISO(today, dayOffset);
      // 1人1日 2件（12時・16時＝重ならない）
      for (let j = 0; j < 2; j++) {
        const course = courses[(ti + j) % courses.length]!;
        const cust = custs[(ti + j) % custs.length]!;
        const startH = 12 + j * 4; // 12, 16
        const start = `${String(startH).padStart(2, "0")}:00`;
        const { startAt } = shiftInstants(dateISO, start, start);
        const startMs = startAt.getTime();
        const serviceEndAt = new Date(startMs + course.duration_min * 60_000);
        const departAt = new Date(startMs - 25 * 60_000);
        const freeAt = new Date(serviceEndAt.getTime() + 10 * 60_000);
        const nomFee = course.nomination_fee_default;
        const total = course.price + nomFee;
        const rid = `cf000000-0000-4000-8000-${String(ti).padStart(4, "0")}${dayOffset}${String(j).padStart(7, "0")}`;
        await sql`
          insert into reservations (
            id, therapist_id, customer_id, address_id, area_id, course_id,
            start_at, end_at, depart_at, free_at,
            travel_in_min, travel_out_min, buffer_min,
            status, nomination_fee, transport_fee, total_amount, source,
            phone_confirmed_at, phone_confirmed_by
          )
          values (
            ${rid}::uuid, ${t.id}::uuid, ${cust.id}::uuid, ${cust.address_id}::uuid, ${areaId}::uuid, ${course.id}::uuid,
            ${startAt}, ${serviceEndAt}, ${departAt}, ${freeAt},
            15, 15, 30,
            'confirmed'::reservation_status, ${nomFee}, 0, ${total}, 'phone'::reservation_source,
            ${startAt}, ${RECEPTION}::uuid
          )
          on conflict (id) do nothing
        `;
        confirmedCount++;
      }
    }
  }
  console.log(`confirmed 予約(当日+翌日): ~${confirmedCount}`);

  // ---- 2.6) 当日タイムライン: 終わった仕事(done)+これからの仕事(confirmed) 混在 ----
  // 案内表の「左=終わった / 右=これから」と「次案内可能〜何分まで可能か」を実データで確認する。
  // yuna/mei/rin（index 3-5）に、今日 done×2 + confirmed×2 を非重複スロット（11/14/18/21時・60分）で作る。
  const shortCourse = courses[0]!; // 最短コース（重複回避）
  let todayTimelineCount = 0;
  for (let ti = 3; ti < targets.length; ti++) {
    const t = targets[ti]!;
    const cust = custs[ti % custs.length]!;
    const slots: { h: number; status: "done" | "confirmed" }[] = [
      { h: 11, status: "done" },
      { h: 14, status: "done" },
      { h: 18, status: "confirmed" },
      { h: 21, status: "confirmed" },
    ];
    for (let si = 0; si < slots.length; si++) {
      const slot = slots[si]!;
      const start = `${String(slot.h).padStart(2, "0")}:00`;
      const { startAt } = shiftInstants(today, start, start);
      const startMs = startAt.getTime();
      const serviceEndAt = new Date(startMs + shortCourse.duration_min * 60_000);
      const departAt = new Date(startMs - 25 * 60_000);
      const freeAt = new Date(serviceEndAt.getTime() + 10 * 60_000);
      const nomFee = shortCourse.nomination_fee_default;
      const total = shortCourse.price + nomFee;
      const rid = `70da0000-0000-4000-8000-${String(ti).padStart(4, "0")}${String(si).padStart(8, "0")}`;
      if (slot.status === "done") {
        await sql`
          insert into reservations (
            id, therapist_id, customer_id, address_id, area_id, course_id,
            start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min,
            status, nomination_fee, transport_fee, total_amount, source,
            enroute_at, arrived_at, service_started_at, done_at
          ) values (
            ${rid}::uuid, ${t.id}::uuid, ${cust.id}::uuid, ${cust.address_id}::uuid, ${areaId}::uuid, ${shortCourse.id}::uuid,
            ${startAt}, ${serviceEndAt}, ${departAt}, ${freeAt}, 15, 15, 30,
            'done'::reservation_status, ${nomFee}, 0, ${total}, 'phone'::reservation_source,
            ${departAt}, ${startAt}, ${startAt}, ${serviceEndAt}
          ) on conflict (id) do nothing
        `;
      } else {
        await sql`
          insert into reservations (
            id, therapist_id, customer_id, address_id, area_id, course_id,
            start_at, end_at, depart_at, free_at, travel_in_min, travel_out_min, buffer_min,
            status, nomination_fee, transport_fee, total_amount, source,
            phone_confirmed_at, phone_confirmed_by
          ) values (
            ${rid}::uuid, ${t.id}::uuid, ${cust.id}::uuid, ${cust.address_id}::uuid, ${areaId}::uuid, ${shortCourse.id}::uuid,
            ${startAt}, ${serviceEndAt}, ${departAt}, ${freeAt}, 15, 15, 30,
            'confirmed'::reservation_status, ${nomFee}, 0, ${total}, 'phone'::reservation_source,
            ${startAt}, ${RECEPTION}::uuid
          ) on conflict (id) do nothing
        `;
      }
      todayTimelineCount++;
    }
  }
  console.log(`当日タイムライン(done+confirmed): ~${todayTimelineCount}`);

  // ---- 3) 過去の接客(done予約) + 4) 売上+報酬(revenue_lines/payout_lines)----
  // 各対象に、過去14日から数日おきに done 予約を作る（1日1件で exclusion 回避）。
  // ★デモ会計は「売上（course+nomination）」と「バック（実レート）」を必ずセットで作る。
  //   売上ゼロ・バック40%固定の旧デモは日次会計のバック率を壊すため、
  //   デモ予約(dede0000-…)の既存台帳をいったん消してから正しい数字で作り直す（再実行で自己修復）。
  await sql`delete from payments      where reservation_id::text like 'dede0000-%'`;
  await sql`delete from payout_lines  where reservation_id::text like 'dede0000-%'`;
  await sql`delete from revenue_lines where reservation_id::text like 'dede0000-%'`;
  let resCount = 0;
  let payoutCount = 0;
  for (let ti = 0; ti < targets.length; ti++) {
    const t = targets[ti]!;
    const courseRate = resolveCourseRate(t);
    for (let k = 0; k < 6; k++) {
      const offset = -(2 + k * 2) - ti; // 過去日・セラピストごとにずらす
      const dateISO = addDaysISO(today, offset);
      const course = courses[k % courses.length]!;
      const cust = custs[k % custs.length]!;
      const startH = 11 + (k % 6); // 11-16時
      const start = `${String(startH).padStart(2, "0")}:00`;
      const { startAt } = shiftInstants(dateISO, start, start);
      const startMs = startAt.getTime();
      const serviceEndAt = new Date(startMs + course.duration_min * 60_000);
      const departAt = new Date(startMs - 25 * 60_000);
      const freeAt = new Date(serviceEndAt.getTime() + 10 * 60_000);
      const nomFee = course.nomination_fee_default;
      const total = course.price + nomFee;
      // 決定的UUID（重複回避）
      const rid = `dede0000-0000-4000-8000-${String(ti).padStart(4, "0")}${String(k).padStart(8, "0")}`;
      await sql`
        insert into reservations (
          id, therapist_id, customer_id, address_id, area_id, course_id,
          start_at, end_at, depart_at, free_at,
          travel_in_min, travel_out_min, buffer_min,
          status, nomination_fee, transport_fee, total_amount, source,
          enroute_at, arrived_at, service_started_at, done_at
        )
        values (
          ${rid}::uuid, ${t.id}::uuid, ${cust.id}::uuid, ${cust.address_id}::uuid, ${areaId}::uuid, ${course.id}::uuid,
          ${startAt}, ${serviceEndAt}, ${departAt}, ${freeAt},
          15, 15, 30,
          'done'::reservation_status, ${nomFee}, 0, ${total}, 'phone'::reservation_source,
          ${departAt}, ${startAt}, ${startAt}, ${serviceEndAt}
        )
        on conflict (id) do nothing
      `;
      resCount++;

      // 売上（spec L856: 独立行・合算しない）。occurred_at は施術日(start_at)＝
      //   日次会計の営業日境界(06:00)と揃う。course/nomination で total_amount と一致。
      const bizDate = dateISO;
      await sql`
        insert into revenue_lines (reservation_id, line_type, amount, area_id, therapist_id, occurred_at)
        values (${rid}::uuid, 'course', ${course.price}, ${areaId}::uuid, ${t.id}::uuid, ${startAt})
      `;
      if (nomFee > 0) {
        await sql`
          insert into revenue_lines (reservation_id, line_type, amount, area_id, therapist_id, occurred_at)
          values (${rid}::uuid, 'nomination', ${nomFee}, ${areaId}::uuid, ${t.id}::uuid, ${startAt})
        `;
      }
      // 支払方法（現金）。日次会計の支払方法内訳が空にならないように。
      await sql`
        insert into payments (reservation_id, method, amount, occurred_at)
        values (${rid}::uuid, 'cash', ${total}, ${startAt})
      `;

      // 報酬: コースは実レート（個別>ランク>既定）、指名は100%（engine と同じ枠組み）。
      const courseBack = Math.floor((course.price * courseRate) / 100);
      await sql`
        insert into payout_lines (therapist_id, business_date, reservation_id, category, amount, calc_note)
        values (${t.id}::uuid, ${bizDate}::date, ${rid}::uuid, 'course', ${courseBack},
                ${sql.json({ demo: true, formula: `${course.price}*${courseRate}%`, base: course.price, rate: courseRate })})
      `;
      payoutCount++;
      if (nomFee > 0) {
        await sql`
          insert into payout_lines (therapist_id, business_date, reservation_id, category, amount, calc_note)
          values (${t.id}::uuid, ${bizDate}::date, ${rid}::uuid, 'nomination', ${nomFee},
                  ${sql.json({ demo: true, formula: "nomination_fee*100%", base: nomFee, rate: 100 })})
        `;
        payoutCount++;
      }
    }
  }
  console.log(`done reservations: ~${resCount} / payout_lines: ~${payoutCount}`);

  console.log("demo seed 完了");
  await sql.end({ timeout: 5 });
}

main().catch((e) => {
  console.error("demo seed 失敗:", e);
  process.exit(1);
});

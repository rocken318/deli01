import type { Metadata } from 'next';
import { getClient } from '@/lib/db-client';
import OrderEntryForm from './OrderEntryForm';

export const metadata: Metadata = {
  title: '電話受付オーダーエントリー',
};

interface TherapistRow {
  id: string;
  slug: string;
  display_name: string | null;
}

interface CourseRow {
  id: string;
  name: string;
  duration_min: number;
  price: number;
  nomination_fee_default: number;
}

interface OptionRow {
  id: string;
  name: string;
  price: number;
  duration_min: number;
}

interface AreaRow {
  id: string;
  name: string;
}

export default async function OrderEntryPage() {
  const sql = getClient();

  const [therapists, courses, options, areas] = await Promise.all([
    sql<TherapistRow[]>`
      select t.id, t.slug,
             r.published->>'name' as display_name
      from therapists t
      left join entity_records r on r.entity = 'therapist' and r.slug = t.slug
      where t.status = 'active'
      order by t.display_order asc
    `,
    sql<CourseRow[]>`
      select id, name, duration_min, price, nomination_fee_default
      from courses where is_active = true
      order by sort_order asc, duration_min asc
    `,
    sql<OptionRow[]>`
      select id, name, price, duration_min
      from options where is_active = true and is_public = true
      order by sort_order asc
    `,
    sql<AreaRow[]>`
      select id, name from areas where is_active = true
      order by sort_order asc
    `,
  ]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-adm-text mb-6">電話受付オーダーエントリー</h1>
      <OrderEntryForm
        therapists={therapists.map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.display_name ?? t.slug,
        }))}
        courses={courses}
        options={options}
        areas={areas}
      />
    </div>
  );
}

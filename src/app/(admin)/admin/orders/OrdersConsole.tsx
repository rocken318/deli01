'use client';

import { useState } from 'react';
import OrderEntryForm from './OrderEntryForm';
import AnnaiMiniBar from './AnnaiMiniBar';
import type { AnnaiMiniItem } from '@/lib/annai/mini-actions';

interface Therapist { id: string; slug: string; name: string; }
interface Course { id: string; name: string; duration_min: number; price: number; nomination_fee_default: number; }
interface Option { id: string; name: string; price: number; duration_min: number; }
interface Area { id: string; name: string; }

interface Props {
  therapists: Therapist[];
  courses: Course[];
  options: Option[];
  areas: Area[];
  initialPhone?: string;
  initialAnnaiItems: AnnaiMiniItem[];
}

export default function OrdersConsole({
  therapists, courses, options, areas, initialPhone, initialAnnaiItems,
}: Props) {
  const [externalTherapist, setExternalTherapist] = useState<Therapist | null>(null);

  return (
    <div>
      <AnnaiMiniBar
        items={initialAnnaiItems}
        onPick={(t) => setExternalTherapist(t)}
      />
      <OrderEntryForm
        therapists={therapists}
        courses={courses}
        options={options}
        areas={areas}
        initialPhone={initialPhone}
        externalTherapist={externalTherapist}
      />
    </div>
  );
}

import { Notice } from '@/components/ui/Notice';

/** Says which person of a group template was swapped. Renders nothing for a one-person template. */
export function SubjectNotice({ peopleCount, subjectLabel }: { peopleCount: number | null; subjectLabel: string | null }) {
  if (peopleCount === null || peopleCount <= 1) return null;
  return (
    <Notice tone="info">
      Your template had {peopleCount} people. We swapped {subjectLabel ?? 'the person marked in the template'}.
    </Notice>
  );
}

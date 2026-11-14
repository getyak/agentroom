import type { CSSProperties, ReactNode } from "react";
import { Users } from "lucide-react";
import "./group-avatar.css";

export function GroupAvatar({ size = "", members = [], peer }: { size?: string; members?: ReactNode[]; peer?: ReactNode }) {
  const single = members.length > 0 && members.length < 3;
  const triangle = members.length === 3;
  const columns = members.length <= 4 ? 2 : 3;
  const rows: ReactNode[][] = [];
  for (let offset = 0; offset < members.length;) {
    const length = offset === 0 ? members.length % columns || columns : columns;
    rows.push(members.slice(offset, offset + length));
    offset += length;
  }
  return <span className={`im-avatar im-avatar-group im-group-portrait im-group-mosaic ${size} ${single ? "im-group-peer" : ""}`} data-testid="im-avatar" data-avatar-source="group" data-group-avatar-kind={single ? "peer" : members.length ? "members" : "default"} data-member-count={members.length} aria-hidden="true">
    {single ? <span className="im-group-single">{peer || members[0]}</span> : members.length ? <span className={`im-group-collage ${triangle ? "im-group-triangle" : ""}`} data-testid="im-group-avatar-collage" style={{ "--group-columns": columns } as CSSProperties}>
      {triangle ? members : rows.map((row, index) => <span className="im-group-collage-row" key={index}>{row}</span>)}
    </span> : <Users size={23} strokeWidth={1.6} />}
  </span>;
}

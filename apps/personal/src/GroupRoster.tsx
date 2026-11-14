import { Avatar } from './ContactAvatar';
import { groupState, type GroupSnapshot } from './group-types';
import type { Contact } from './types';
export function GroupRoster({ roster, onRemove }: { roster: GroupSnapshot['roster']; onRemove?: (id: string) => void }) {
  return <div className="group-roster" data-testid="group-roster">{roster.map(member => <div className="group-member" key={member.id}><Avatar contact={member as unknown as Contact} size="small" /><span><strong>{member.name}<small>{member.kind === 'agent' ? 'AI' : member.id === 'self' ? '主人' : '朋友'}</small></strong><small>{groupState(member)}</small></span>{onRemove && member.id.startsWith('guest_') && <button onClick={() => onRemove(member.id)} aria-label={`移除 ${member.name}`}>移除</button>}</div>)}</div>;
}

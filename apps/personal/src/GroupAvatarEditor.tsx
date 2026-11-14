import { Avatar, type AvatarContact } from "./ContactAvatar";

export function GroupAvatarEditor({ members }: { members: readonly AvatarContact[] }) {
  return <div className="im-group-avatar-editor" data-testid="im-group-avatar-editor">
    <div className="im-group-avatar-heading">
      <div className="im-group-avatar-preview" data-testid="im-group-avatar-preview"><Avatar group members={members} size="hero" /></div>
      <div className="im-group-avatar-copy"><strong>大家的头像，拼成一个群</strong><span>随成员和头像自动更新 · 最多九位</span></div>
    </div>
  </div>;
}

import type { AgentConfiguration, AgentProfile, ExecutionSnapshot } from './types';
export type RoomieCard = { id: string; kind: 'local'|'role'|'group'|'existing'; title: string; description: string; rationale?: string; agentId?: string; canTest?: boolean; contactId?: string|null; threadId?: string|null; jobId?: string; memberNames?: string[]; source?: string };
export type RoomieState = {
 threadId: string; messages: {id:string;role:string;text:string;createdAt:string}[];
 agents: {id:string;name:string;authStatus:string;executionSupported:boolean;planningSupported:boolean;execution:ExecutionSnapshot|null;profile:AgentProfile|null;configurationError:string;setupUrl:string|null}[];
 connections:{id:string;name:string;type:string;status:string}[];
 projects:{id:string;name:string;root:string;mode:string}[];links:{id:string;url:string;label:string}[];
 settings:{guideOnly?:boolean;monitor:boolean;monitorGuidanceDone?:boolean;automaticGroups?:boolean;agentId:string|null;topic:string;projectId?:string};
 job:{id:string;status:string;stopUnconfirmed?:boolean;error?:string;source?:string;planningError?:string;probe:{status:string;testedAt?:string};executionSnapshot:ExecutionSnapshot}|null;
 recommendations:RoomieCard[];sampledAt:string;
};
export type RoomieMessage = {text:string;agentId?:string;configuration?:AgentConfiguration};

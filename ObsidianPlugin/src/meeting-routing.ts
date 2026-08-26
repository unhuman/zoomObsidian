export type MeetingSource = "owned" | "shared";

export interface MeetingParticipantClassification {
  topicParts: string[];
  topicNonSelf: string[];
  otherAttendees: string[];
  topicHasMultiplePeople: boolean;
  isGroupTopic: boolean;
}

/**
 * Classify participant evidence used by the sync planner. Full names are kept
 * as single topic parts, while numeric-only fragments from labels such as
 * "1:1" are ignored.
 */
export function classifyMeetingParticipants(
  topic: string,
  attendees: string[],
  selfFirstName: string,
  sourceType: MeetingSource
): MeetingParticipantClassification {
  const topicParts = topic
    .split(":")
    .map((part) => part.trim())
    .filter((part) => part && /[a-zA-Z]{2,}/.test(part));
  const normalizedSelfFirst = selfFirstName.trim().toLowerCase();
  const isSelf = (name: string) =>
    normalizedSelfFirst ? name.toLowerCase().includes(normalizedSelfFirst) : false;
  const otherAttendees = attendees.filter(
    (name) => !isSelf(name) && !/\d/.test(name)
  );
  const topicNonSelf = topicParts.filter((part) => !isSelf(part));
  const topicHasMultiplePeople = normalizedSelfFirst
    ? topicNonSelf.length > 1
    : topicParts.length >= 3;

  return {
    topicParts,
    topicNonSelf,
    otherAttendees,
    topicHasMultiplePeople,
    isGroupTopic:
      sourceType === "owned" &&
      (topicHasMultiplePeople || otherAttendees.length > 1),
  };
}

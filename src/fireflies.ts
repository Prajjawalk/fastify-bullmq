import { env } from './env';

interface FirefliesTranscriptResponse {
  data: {
    transcript: {
      id: string;
      title: string;
      date: string;
      dateString: string;
      duration: number;
      organizerEmail: string;
      hostEmail?: string;
      participants: string[];
      firefliesUsers: string[];
      transcriptUrl?: string;
      audioUrl?: string;
      videoUrl?: string;
      meetingLink?: string;
      calendarType?: string;
      calendarId?: string;
      privacy?: string;
      speakers?: Array<{ id: string; name: string }>;
      meetingAttendees?: Array<{
        displayName?: string;
        email?: string;
        phoneNumber?: string;
        name?: string;
        location?: string;
      }>;
      meetingAttendance?: Array<{
        name: string;
        join_time: string;
        leave_time: string;
      }>;
      sentences?: Array<{
        index: number;
        speaker_name: string;
        speaker_id: string;
        text: string;
        raw_text: string;
        start_time: number;
        end_time: number;
        ai_filters?: {
          task?: boolean;
          pricing?: boolean;
          metric?: boolean;
          question?: boolean;
          date_and_time?: boolean;
          text_cleanup?: boolean;
          sentiment?: string;
        };
      }>;
      summary?: {
        keywords?: string[];
        action_items?: string[];
        outline?: string;
        shorthand_bullet?: string;
        overview?: string;
        bullet_gist?: string;
        gist?: string;
        short_summary?: string;
        short_overview?: string;
        meeting_type?: string;
        topics_discussed?: string[];
        transcript_chapters?: Array<{
          title: string;
          start_time: number;
          end_time: number;
        }>;
      };
      analytics?: {
        sentiments?: {
          negative_pct: number;
          neutral_pct: number;
          positive_pct: number;
        };
        categories?: {
          questions: number;
          date_times: number;
          metrics: number;
          tasks: number;
        };
        speakers?: Array<{
          speaker_id: string;
          name: string;
          duration: number;
          word_count: number;
          longest_monologue: number;
          monologues_count: number;
          filler_words: number;
          questions: number;
          duration_pct: number;
          words_per_minute: number;
        }>;
      };
      meetingInfo?: {
        fred_joined: boolean;
        silent_meeting: boolean;
        summary_status: string;
      };
    };
  };
}

const GRAPHQL_QUERY = `
  query Transcript($transcriptId: String!) {
    transcript(id: $transcriptId) {
      id
      title
      date
      dateString
      duration
      organizer_email
      host_email
      participants
      fireflies_users
      transcript_url
      audio_url
      video_url
      meeting_link
      calendar_type
      calendar_id
      privacy
      speakers {
        id
        name
      }
      meeting_attendees {
        displayName
        email
        phoneNumber
        name
        location
      }
      meeting_attendance {
        name
        join_time
        leave_time
      }
      sentences {
        index
        speaker_name
        speaker_id
        text
        raw_text
        start_time
        end_time
        ai_filters {
          task
          pricing
          metric
          question
          date_and_time
          text_cleanup
          sentiment
        }
      }
      summary {
        keywords
        action_items
        outline
        shorthand_bullet
        overview
        bullet_gist
        gist
        short_summary
        short_overview
        meeting_type
        topics_discussed
        transcript_chapters {
          title
          start_time
          end_time
        }
      }
      analytics {
        sentiments {
          negative_pct
          neutral_pct
          positive_pct
        }
        categories {
          questions
          date_times
          metrics
          tasks
        }
        speakers {
          speaker_id
          name
          duration
          word_count
          longest_monologue
          monologues_count
          filler_words
          questions
          duration_pct
          words_per_minute
        }
      }
      meeting_info {
        fred_joined
        silent_meeting
        summary_status
      }
    }
  }
`;

export async function fetchTranscriptFromFireflies(
  meetingId: string
): Promise<FirefliesTranscriptResponse['data']['transcript']> {
  const FIREFLIES_API_KEY = env.FIREFLIES_API_KEY;

  const response = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${FIREFLIES_API_KEY}`,
    },
    body: JSON.stringify({
      query: GRAPHQL_QUERY,
      variables: {
        transcriptId: meetingId,
      },
    }),
  });

  // Always parse response body to get detailed error messages
  const data = await response.json();

  if (!response.ok) {
    // Log the full error response for debugging
    console.error(
      'Fireflies API Error Response:',
      JSON.stringify(data, null, 2)
    );
    throw new Error(
      `Failed to fetch transcript from Fireflies: ${
        response.statusText
      } - ${JSON.stringify(data)}`
    );
  }

  // Check for GraphQL errors (these can occur even with 200 status)
  if (data.errors) {
    console.error(
      'Fireflies GraphQL Errors:',
      JSON.stringify(data.errors, null, 2)
    );
    throw new Error(`Fireflies GraphQL errors: ${JSON.stringify(data.errors)}`);
  }

  if (!data.data?.transcript) {
    throw new Error('No transcript data returned from Fireflies API');
  }

  return data.data.transcript;
}

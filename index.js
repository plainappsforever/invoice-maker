// App entry. Reminders first: the background task (`im-replan`) and the notification-answer listener must exist in
// every JS context, also when the OS starts the app only for them (D73). Then Expo Router as usual.
import './src/lib/reminders';
import 'expo-router/entry';

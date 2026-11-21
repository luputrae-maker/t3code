"""Offline checks: no model calls, credentials or external writes."""
import unittest
from classify import classify


class StubClient:
    def __init__(self, choice):
        self.choice = choice
        self.calls = 0

    def route_task(self, task, workers, profiles, *, choose_effort=False):
        self.calls += 1
        self.choose_effort = choose_effort
        result = dict(profile=self.choice, model='jev-test', confidence=0.9, usage={},
                      probabilities={self.choice: 1.0})
        if choose_effort:
            result['effort'] = 'high'
        return result


class ClassificationBoundaryTests(unittest.TestCase):
    def test_effort_is_requested_for_an_effort_capable_catalog(self):
        profile = dict(id='gemini', provider='antigravity', model='gemini-pro',
                       description='Native coding', effort=dict(id='thinking_level', values=['low', 'high']))
        client = StubClient('gemini')
        result = classify(dict(task='Review a hard design problem', candidates=[profile]), client)
        self.assertEqual(result['profile'], profile)
        self.assertTrue(client.choose_effort)
        self.assertEqual(result['effort'], 'high')

    def test_realistic_catalog_size_can_select_an_antigravity_model(self):
        candidates = [
            dict(id=f'codex:{i}', provider='codex', model=f'gpt-{i}', description='Native coding')
            for i in range(70)
        ]
        selected = dict(id='antigravity:gemini-pro', provider='antigravity', model='gemini-pro',
                        description='Google-account agent')
        candidates.append(selected)
        client = StubClient(selected['id'])
        result = classify(dict(task='Use Gemini Pro for the review', candidates=candidates), client)
        self.assertEqual(result['profile'], selected)
        self.assertEqual(client.calls, 1)

    def test_cursor_remains_cursor_after_legacy_worker_translation(self):
        profile = dict(id='cursor', provider='cursor', model='composer-2.5',
                       description='Cursor native', options=[])
        client = StubClient('cursor')
        result = classify(dict(task='Fix a bug', candidates=[profile]), client)
        self.assertEqual(result['profile'], profile)
        self.assertEqual(result['classifier'], 'jev-test')
        self.assertEqual(result.get('probabilities'), {'cursor': 1.0})
        self.assertFalse(client.choose_effort)

    def test_paid_opencode_target_is_rejected_before_classifier_call(self):
        client = StubClient('paid')
        profile = dict(id='paid', provider='opencode', model='openrouter/paid',
                       description='Wrong account')
        with self.assertRaises(ValueError):
            classify(dict(task='Fix a bug', candidates=[profile]), client)
        self.assertEqual(client.calls, 0)

    def test_unoffered_selection_cannot_dispatch(self):
        profile = dict(id='codex', provider='codex', model='gpt-6.1-sol',
                       description='Native coding')
        with self.assertRaises(StopIteration):
            classify(dict(task='Fix a bug', candidates=[profile]), StubClient('unknown'))


if __name__ == '__main__':
    unittest.main()

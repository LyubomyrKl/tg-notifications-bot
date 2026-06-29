import {
  parsePlaceholders,
  renderTemplate,
  UnfilledPlaceholdersError,
} from './placeholder.util';

describe('placeholder engine', () => {
  it('parses unique placeholder names in first-seen order', () => {
    expect(parsePlaceholders('Hi {name}, your {item} for {name} is ready')).toEqual([
      'name',
      'item',
    ]);
    expect(parsePlaceholders('no placeholders here')).toEqual([]);
  });

  it('renders when all placeholders are filled', () => {
    expect(
      renderTemplate('Hi {name}, {item} ships {when}', {
        name: 'Ada',
        item: 'Widget',
        when: 'today',
      }),
    ).toBe('Hi Ada, Widget ships today');
  });

  it('rejects unfilled placeholders with the missing names', () => {
    try {
      renderTemplate('Hi {name}, {item}', { name: 'Ada' });
      fail('expected UnfilledPlaceholdersError');
    } catch (err) {
      expect(err).toBeInstanceOf(UnfilledPlaceholdersError);
      expect((err as UnfilledPlaceholdersError).missing).toEqual(['item']);
    }
  });

  it('treats empty-string values as unfilled', () => {
    expect(() => renderTemplate('{a}', { a: '' })).toThrow(
      UnfilledPlaceholdersError,
    );
  });
});

import {
  isFacebookStickerUrl,
  isMessengerStickerAttachment,
  looksLikeInboundStickerFlag,
} from './inbound-sticker';

describe('inbound-sticker Messenger fbcdn', () => {
  const fbSticker =
    'https://scontent.xx.fbcdn.net/v/t39.1997-6/123_n.png?stp=dst-jpg_s100x100&_nc_cat=1&oh=abc';

  it('detecta thumbs s100x100 / s120x120 en fbcdn', () => {
    expect(isFacebookStickerUrl(fbSticker)).toBe(true);
    expect(
      isFacebookStickerUrl(
        'https://scontent.xx.fbcdn.net/v/t1.0-9/x.png?stp=dst-jpg_s120x120&oe=1',
      ),
    ).toBe(true);
    expect(
      isFacebookStickerUrl('https://cdn.example.com/damage.png?w=800'),
    ).toBe(false);
    expect(
      isFacebookStickerUrl(
        'https://scontent.xx.fbcdn.net/v/t39.1997-6/abc_n.png?_nc_cat=1',
      ),
    ).toBe(false);
  });

  it('clasifica attachment image sin sticker_id si la URL es de sticker', () => {
    expect(
      isMessengerStickerAttachment({
        type: 'image',
        payload: { url: fbSticker },
      }),
    ).toBe(true);
    expect(
      isMessengerStickerAttachment({
        type: 'image',
        payload: { sticker_id: 123, url: 'https://scontent.xx.fbcdn.net/big.jpg' },
      }),
    ).toBe(true);
  });

  it('looksLikeInboundStickerFlag lee la URL del message', () => {
    expect(looksLikeInboundStickerFlag({ message: fbSticker })).toBe(true);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replacementPrompt } from '../src/ai-plan.js';
import { fitLayout } from '../src/ai-layout.js';

test('full-sentence user requirements stay separate from the replacement target grammar and enforce frame-specific expressions', () => {
  const subject = 'This is a frame-by-frame composite of a GIF; the main character needs to be replaced in each frame while maintaining the overall continuity of the GIF，并且保持main character 姿势神态表情不变，使用参考人设替换它。';
  const notes = '用这个替代角色替换逐帧图中的main character，保留main character的姿势神态表情不变，注意每一帧之间连贯';
  const prompt = replacementPrompt(fitLayout(240, 240, 4, 1280, 1280, 2, 16, 12), subject, notes, '保留扇子', { referenceCount: 2, registrationMarkers: true });
  assert.ok(prompt.includes(subject)); assert.ok(prompt.includes(notes)); assert.ok(prompt.includes('保留扇子'));
  assert.ok(!prompt.includes(`replace ${subject} with`));
  for (const rule of ['eyelid opening/closing', 'mouth opening/closing', 'Closed eyes must remain closed', 'front/side/back', 'ONE-TO-ONE', 'TEMPORAL CONTINUITY', 'REGISTRATION MARKERS', 'IMAGES 2 through 3']) assert.ok(prompt.includes(rule), rule);
  assert.match(prompt, /Cell 1: .*\nCell 2:/);
});

test('approved effect references cannot override source-frame expressions or poses', () => {
  const prompt = replacementPrompt(fitLayout(240, 240, 1, 1280, 1280, 1, 16, 12), 'main character', '', '', { referenceCount: 2, appearanceReference: true });
  assert.match(prompt, /IMAGE 3 is the APPROVED EDITED FRAME/);
  assert.match(prompt, /eyelids, mouth shape and expression must NEVER override/);
  assert.match(prompt, /IMAGE 2 is the replacement CHARACTER IDENTITY reference/);
  assert.throws(() => replacementPrompt(fitLayout(240, 240, 1, 1280, 1280, 1, 16, 12), '', '', '', { referenceCount: 1, appearanceReference: true }), /reference roles/);
});

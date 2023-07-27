import { useEffect, useState } from 'react';
import { Flex, Tabs } from '@contentful/f36-components';
import useAI from '@hooks/dialog/useAI';
import OutputTextPanels from './output-text-panels/OutputTextPanels';

enum OutputTab {
  UPDATE_ORIGINAL_TEXT = 'original-text',
  GENERATED_TEXT = 'generated-text',
}

interface Props {
  inputText: string;
  outputField: string;
}

const Output = (props: Props) => {
  const { inputText, outputField } = props;
  const ai = useAI();

  const [currentTab, setCurrentTab] = useState(OutputTab.UPDATE_ORIGINAL_TEXT);

  useEffect(() => {
    if (ai.isGenerating) {
      setCurrentTab(OutputTab.GENERATED_TEXT);
    }
  }, [ai.isGenerating]);

  return (
    <Flex margin="spacingL" flexGrow={5}>
      <Tabs
        currentTab={currentTab}
        onTabChange={(tab) => setCurrentTab(tab as OutputTab)}
        style={{ width: '100%' }}>
        <Tabs.List>
          <Tabs.Tab panelId={OutputTab.UPDATE_ORIGINAL_TEXT}> Original Text </Tabs.Tab>
          <Tabs.Tab
            panelId={OutputTab.GENERATED_TEXT}
            isDisabled={(ai.isGenerating && !ai.output.length) || !ai.output.length}>
            Generated Text
          </Tabs.Tab>
        </Tabs.List>

        <OutputTextPanels outputField={outputField} inputText={inputText} ai={ai} />
      </Tabs>
    </Flex>
  );
};

export default Output;
export { OutputTab };
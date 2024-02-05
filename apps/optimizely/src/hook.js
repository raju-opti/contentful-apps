import { useRef, useEffect, useCallback } from 'react';
import { createClient } from 'contentful-management';

export const useLatest = (value) => {
  const ref = useRef(value);

  useEffect(() => {
    ref.current = value;
  }, [value]);

  return useCallback(() => {
    return ref.current;
  }, []);
}

export const useCmaClient = (sdk, retry = 0) => {
  const [done, setDone] = useState(false);
  const resRef = useRef({});
  const errRef = useRef(null);

  useEffect(() => {
    let isActive = true;

    const init = async () => {
      const cma = createClient(
        { apiAdapter: sdk.cmaAdapter },
      )
      try {
        const space = await cma.getSpace(sdk.ids.space)
        const environment = await space.getEnvironment(sdk.ids.environment)
        const entry = await environment.getEntry(sdk.entry.getSys().id);
        if (isActive) {
          resRef.current = { space, environment, entry };
          setDone(true);
        }
      } catch (err) {
        if (retry == -1) init();
        else if (retry--) {
          init();
        } else {
          errRef.current(err);
          setDone(true);
        }
      }
    }

    init();

    return () => {
      isActive = false;
    }
  }, [sdk]);

  return [ done, resRef.current, errRef.current]
}
